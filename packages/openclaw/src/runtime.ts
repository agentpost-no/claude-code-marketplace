import { initSodium, loadOrGenerateHmacKey, loadOrGenerateKeys, toBase64 } from "../../../plugins/agentpost/crypto.js";
import { type InboxEntry, takeUnread } from "../../../plugins/agentpost/inbox.js";
import { type IncomingMailItem, processIncomingEmail } from "../../../plugins/agentpost/mail.js";
import { carriesThirdPartyText, formatDeliveryNotification } from "../../../plugins/agentpost/notice.js";
import { setStorageHome } from "../../../plugins/agentpost/paths.js";
import type { DeliveryNotification, SendEmailResult } from "../../../plugins/agentpost/protocol.js";
import {
	attachmentsFromPaths,
	guardSend,
	replyToThread,
	type SendAttachment,
	type SendContext,
	type SendResult,
	sendNewEmail,
} from "../../../plugins/agentpost/send.js";
import { fetchStatus, loadConfig, register, saveConfig } from "../../../plugins/agentpost/store.js";
import { getAllMessageIds, lookupThread } from "../../../plugins/agentpost/thread.js";
import type { Config, KeyPair, WsClient } from "../../../plugins/agentpost/types.js";
import { createWsClient } from "../../../plugins/agentpost/ws-client.js";
import type { AgentpostAccount } from "./account.js";

/**
 * One agentpost identity, connected.
 *
 * Owns the WebSocket to the worker, the local key material and the storage root. The
 * host supplies callbacks: inbound mail and status notices are pushed to it, and it
 * calls back in to send. Nothing here knows what OpenClaw is.
 */

export interface MailRuntimeCallbacks {
	/** An email arrived, decrypted and wrapped in untrusted-content markers. */
	onMail: (item: IncomingMailItem) => Promise<void> | void;
	/** Delivery report or owner approval result, already formatted for a human. */
	onNotice: (text: string, meta: Record<string, string>) => Promise<void> | void;
	/** Socket came up or went away. Drives the host's channel status. */
	onConnectionChange?: (connected: boolean) => void;
	log: {
		info: (message: string) => void;
		warn: (message: string) => void;
		error: (message: string) => void;
	};
}

export interface MailRuntime {
	/** The agent's address, once registration is active. */
	address: () => string | undefined;
	connected: () => boolean;
	start: () => Promise<void>;
	stop: () => void;
	/** Reply in an existing thread when `threadId` is known, otherwise start a new one. */
	send: (params: {
		to: string;
		text: string;
		threadId?: string | null;
		attachments?: SendAttachment[];
	}) => Promise<SendResult & { threadId?: string }>;
	/** Compose a real email: subject line, optional HTML alternative, attachments. */
	sendEmail: (params: {
		to: string;
		subject: string;
		body: string;
		html_body?: string;
		on_behalf_of?: string;
		footer_language?: "no" | "en";
		/** Local paths, read and base64-encoded before sending. */
		file_paths?: string[];
		/** Already-encoded blobs, for content the agent generated rather than read. */
		attachments?: SendAttachment[];
	}) => Promise<SendResult & { threadId?: string }>;
	/** Reply inside a known thread, keeping the subject and the In-Reply-To chain. */
	reply: (params: { threadId: string; body: string }) => Promise<SendResult & { to?: string; subject?: string }>;
	/** Unread inbound mail and notices, marked read as they are returned. */
	readInbox: (limit: number) => { taken: InboxEntry[]; remaining: number };
}

/** Ids of notices already handed to the host, newest last. Bounded. */
const NOTICE_MEMORY = 200;

export function createMailRuntime(account: AgentpostAccount, cb: MailRuntimeCallbacks): MailRuntime {
	let ws: WsClient | null = null;
	const seenNotices: string[] = [];
	let config: Config | null = null;
	let keys: KeyPair | null = null;
	let hmacKey: Uint8Array | null = null;
	let authenticated = false;

	/**
	 * Hand a status notice to the host at most once.
	 *
	 * The worker re-sends delivery notifications, and each one otherwise starts another
	 * agent turn for the same event. Ids are derived from the event itself, never from
	 * the clock, so a repeat is recognisable.
	 */
	function emitNotice(id: string, text: string, meta: Record<string, string>): void {
		if (seenNotices.includes(id)) return;
		seenNotices.push(id);
		if (seenNotices.length > NOTICE_MEMORY) seenNotices.splice(0, seenNotices.length - NOTICE_MEMORY);
		// A host-side failure must never become an unhandled rejection: that takes the
		// whole gateway process down with it.
		void Promise.resolve(cb.onNotice(text, { ...meta, id })).catch((err) => {
			cb.log.error(`notice delivery failed: ${String(err)}`);
		});
	}

	function sendContext(): SendContext {
		if (!config) throw new Error("agentpost is not registered yet");
		return { workerUrl: config.workerUrl, username: config.username, accessToken: ws?.getAccessToken() ?? null };
	}

	async function ensureRegistered(publicKeyB64: string): Promise<Config | null> {
		const existing = loadConfig();
		if (existing) {
			if (account.username && existing.username !== account.username) {
				cb.log.warn(
					`configured username "${account.username}" does not match the registered "${existing.username}"; using the registered one. Point channels.agentpost.home at a different directory for a second identity.`,
				);
			}
			return existing;
		}

		if (!account.username || !account.ownerEmail) {
			cb.log.error(
				"not registered. Set channels.agentpost.username and channels.agentpost.ownerEmail, then restart the gateway.",
			);
			return null;
		}

		const result = await register(
			account.workerUrl,
			account.username,
			publicKeyB64,
			account.displayName,
			account.ownerEmail,
		);
		const created: Config = {
			workerUrl: account.workerUrl,
			agentId: result.agentId,
			email: result.email,
			username: account.username,
			status: result.status,
		};
		saveConfig(created);
		if (created.status !== "active") {
			cb.log.info(`verification email sent to ${account.ownerEmail}. The address activates once the owner clicks it.`);
		}
		return created;
	}

	function connect(cfg: Config, activeKeys: KeyPair) {
		ws = createWsClient(cfg.workerUrl, cfg.agentId, activeKeys, {
			onAuthenticated() {
				authenticated = true;
				cb.onConnectionChange?.(true);
				cb.log.info(`connected as ${cfg.email}`);
				// Claim our outbound message IDs so replies route to this instance.
				const messageIds = getAllMessageIds();
				if (messageIds.length > 0) ws?.send({ type: "claim_threads", messageIds });
			},
			onEmail(encrypted) {
				void processIncomingEmail(encrypted, {
					keys: activeKeys,
					ack: (id) => ws?.send({ type: "email_ack", id }),
					deliver: (item) => cb.onMail(item),
					log: (message, err) => cb.log.error(`${message} ${err ? String(err) : ""}`.trim()),
				}).catch((err) => {
					cb.log.error(`inbound handling failed: ${String(err)}`);
				});
			},
			onDeliveryNotification(notification: DeliveryNotification) {
				// A bounce reason is written by the receiving mail server, which on a bounce is
				// whoever the agent just mailed. notice.ts fences it; the meta flag tells the
				// gateway not to hand this notice owner standing. See notice.ts.
				emitNotice(`notice:${notification.event}:${notification.messageId}`, formatDeliveryNotification(notification), {
					source: "email",
					event: notification.event,
					recipient: notification.recipient,
					third_party_text: String(carriesThirdPartyText(notification)),
				});
			},
			onSendResult(result: SendEmailResult) {
				const text = result.success
					? `[Email approved] Your email to ${result.to} ("${result.subject}") was approved and sent by the owner.${
							result.contactTrusted ? ` ${result.to} is now a trusted contact and future mail goes out directly.` : ""
						}`
					: `[Email rejected] Your email to ${result.to} ("${result.subject}") was rejected by the owner: ${
							result.error ?? "no reason given"
						}.`;
				emitNotice(`send_result:${result.success ? "approved" : "rejected"}:${result.to}:${result.subject}`, text, {
					source: "email",
					event: result.success ? "approved" : "rejected",
					recipient: result.to,
				});
			},
			onDrainStart(count) {
				cb.log.info(`receiving ${count} stored message(s)`);
			},
			onDrainComplete() {
				cb.log.info("store drain complete");
			},
			onDisconnect() {
				authenticated = false;
				cb.onConnectionChange?.(false);
			},
		});
		ws.connect();
	}

	return {
		address: () => config?.email,
		connected: () => authenticated,

		async start() {
			// libsodium is loaded lazily; every sync crypto call below depends on it.
			await initSodium();
			if (account.home) setStorageHome(account.home);
			keys = loadOrGenerateKeys();
			hmacKey = loadOrGenerateHmacKey();
			const publicKeyB64 = toBase64(keys.publicKey);

			config = await ensureRegistered(publicKeyB64);
			if (!config) return;

			if (config.status === "pending") {
				const status = await fetchStatus(config.workerUrl, config.agentId, publicKeyB64).catch(() => null);
				if (status === "active") {
					config.status = "active";
					saveConfig(config);
				} else {
					// Connecting anyway is deliberate: the worker closes a pending agent with a
					// slow-retry code, so the channel comes up by itself once the owner verifies.
					cb.log.info("waiting for owner verification");
				}
			}

			connect(config, keys);
		},

		stop() {
			ws?.close();
			ws = null;
			authenticated = false;
		},

		async send({ to, text, threadId, attachments }) {
			if (!config || !hmacKey) return { success: false, error: "agentpost is not registered yet" };

			const guard = guardSend(to, config.email, cb.log.warn);
			if (guard) return guard;

			// A known thread id means this is an answer to mail we hold, so keep the
			// subject and In-Reply-To chain rather than starting a fresh conversation.
			if (threadId && lookupThread(threadId) && !attachments?.length) {
				const replied = await replyToThread(threadId, text, sendContext());
				return { ...replied, threadId };
			}

			return sendNewEmail(
				{ to, subject: deriveSubject(text), body: text, attachments },
				{ ...sendContext(), fromAddress: config.email, hmacKey },
			);
		},

		async sendEmail({ file_paths, attachments, ...params }) {
			if (!config || !hmacKey) return { success: false, error: "agentpost is not registered yet" };
			const guard = guardSend(params.to, config.email, cb.log.warn);
			if (guard) return guard;

			let all = [...(attachments ?? [])];
			if (file_paths?.length) {
				try {
					all = [...all, ...(await attachmentsFromPaths(file_paths))];
				} catch (err) {
					return { success: false, error: err instanceof Error ? err.message : String(err) };
				}
			}

			return sendNewEmail(
				{ ...params, attachments: all.length > 0 ? all : undefined },
				{ ...sendContext(), fromAddress: config.email, hmacKey },
			);
		},

		async reply({ threadId, body }) {
			if (!config) return { success: false, error: "agentpost is not registered yet" };
			const thread = lookupThread(threadId);
			if (!thread) return { success: false, error: `Thread not found: ${threadId}` };
			const guard = guardSend(thread.to, config.email, cb.log.warn);
			if (guard) return guard;
			return replyToThread(threadId, body, sendContext());
		},

		readInbox(limit) {
			return takeUnread(limit);
		},
	};
}

/** OpenClaw messages have no subject line, so take one from the body. */
export function deriveSubject(text: string): string {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return "Message from your agent";
	return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}
