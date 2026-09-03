import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { type AgentpostAccount, accountAddress, CHANNEL_ID, listAccountIds, resolveAccount } from "./account.js";
import { clearRuntimes, listRuntimes, setRuntime } from "./registry.js";
import { createMailRuntime } from "./runtime.js";

const CHANNEL_LABEL = "Agentpost";

/**
 * Background service: one WebSocket per configured account, for the life of the gateway.
 *
 * Inbound mail is dispatched as a direct message from the sender's address. The reply
 * the agent produces is handed straight back to the same thread, so an email
 * conversation behaves like any other DM conversation in OpenClaw.
 */
export function createAgentpostService(api: OpenClawPluginApi) {
	return {
		id: "agentpost",

		async start(ctx: {
			config: unknown;
			stateDir: string;
			logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
			serviceHealth?: { reportFailure: (error: unknown) => void; clearFailure: () => void };
		}) {
			const cfg = ctx.config as Parameters<typeof resolveAccount>[0];

			for (const accountId of listAccountIds(cfg)) {
				const resolved = resolveAccount(cfg, accountId);
				if (!resolved.enabled) continue;
				if (!resolved.username && !resolved.ownerEmail) continue;

				// Each account gets its own storage root: keys are per identity, and two
				// identities sharing a directory would share a keypair.
				const account: AgentpostAccount = {
					...resolved,
					home: resolved.home ?? join(ctx.stateDir, "agentpost", accountId),
				};

				const prefix = `[agentpost:${accountId}]`;
				const runtime = createMailRuntime(account, {
					log: {
						info: (m) => ctx.logger.info(`${prefix} ${m}`),
						warn: (m) => ctx.logger.warn(`${prefix} ${m}`),
						error: (m) => ctx.logger.error(`${prefix} ${m}`),
					},

					async onMail(item) {
						const recipient = accountAddress(account) ?? runtime.address() ?? "";
						await dispatchInboundDirectDmWithRuntime({
							cfg,
							runtime: api.runtime,
							channel: CHANNEL_ID,
							channelLabel: CHANNEL_LABEL,
							accountId,
							peer: { kind: "direct", id: item.from },
							senderId: item.from,
							senderAddress: item.from,
							recipientAddress: recipient,
							conversationLabel: item.subject,
							// Already wrapped in UNTRUSTED EXTERNAL CONTENT markers by the core.
							rawBody: item.content,
							// The reply thread id doubles as the platform message id, so an
							// agent reply routes back into the same email thread.
							messageId: item.replyThreadId,
							timestamp: Date.parse(item.receivedAt) || undefined,
							deliver: async (payload) => {
								const text = payload.text?.trim();
								if (!text) return;
								const sent = await runtime.send({ to: item.from, text, threadId: item.replyThreadId });
								if (!sent.success) throw new Error(sent.error ?? "reply failed");
							},
							onRecordError: (err) => ctx.logger.error(`${prefix} failed to record session: ${String(err)}`),
							onDispatchError: (err, info) =>
								ctx.logger.error(`${prefix} ${info.kind} dispatch failed: ${String(err)}`),
						});
					},

					async onNotice(text, meta) {
						// Delivery reports and approval results come from our own worker over an
						// authenticated socket, so they are not wrapped as untrusted. They are
						// dispatched as if from the owner, which is also where a reply belongs.
						if (!account.ownerEmail) {
							ctx.logger.info(`${prefix} ${text}`);
							return;
						}
						await dispatchInboundDirectDmWithRuntime({
							cfg,
							runtime: api.runtime,
							channel: CHANNEL_ID,
							channelLabel: CHANNEL_LABEL,
							accountId,
							peer: { kind: "direct", id: account.ownerEmail },
							senderId: account.ownerEmail,
							senderAddress: account.ownerEmail,
							recipientAddress: accountAddress(account) ?? runtime.address() ?? "",
							conversationLabel: "Agentpost status",
							rawBody: text,
							messageId: `notice:${meta.event ?? "status"}:${Date.now()}`,
							// The worker authenticated this, not an arbitrary sender.
							inboundAccessAuthorized: true,
							deliver: async (payload) => {
								const body = payload.text?.trim();
								if (!body || !account.ownerEmail) return;
								const sent = await runtime.send({ to: account.ownerEmail, text: body });
								if (!sent.success) throw new Error(sent.error ?? "reply failed");
							},
							onRecordError: (err) => ctx.logger.error(`${prefix} failed to record session: ${String(err)}`),
							onDispatchError: (err, info) =>
								ctx.logger.error(`${prefix} ${info.kind} dispatch failed: ${String(err)}`),
						});
					},
				});

				setRuntime(accountId, runtime);
				try {
					await runtime.start();
					ctx.serviceHealth?.clearFailure();
				} catch (err) {
					ctx.logger.error(`${prefix} failed to start: ${String(err)}`);
					ctx.serviceHealth?.reportFailure(err);
				}
			}
		},

		stop() {
			for (const [, runtime] of listRuntimes()) runtime.stop();
			clearRuntimes();
		},
	};
}
