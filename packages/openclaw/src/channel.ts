import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { basename } from "node:path";
import type { SendAttachment } from "../../../plugins/agentpost/send.js";
import { type AgentpostAccount, CHANNEL_ID, inspectAccount, listAccountIds, resolveAccount } from "./account.js";
import { startAccount, stopAccount } from "./gateway.js";
import { getRuntime } from "./registry.js";

/**
 * The agentpost channel.
 *
 * A direct-message channel whose peers are email addresses. Outbound goes through the
 * worker, which holds it for owner approval unless the contact is already trusted, so
 * there is deliberately no local approval seam here.
 */

/** Required surfaces of a channel plugin: identity, capabilities and account config. */
/**
 * Read whatever media the host handed us into a base64 attachment.
 *
 * The host may pass a local path (with its own reader, which enforces the sandbox
 * roots) or a URL. Returning null rather than throwing keeps a fetchable-but-missing
 * asset from losing the message body along with it.
 */
async function readMedia(ctx: {
	mediaUrl?: string;
	mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<SendAttachment | null> {
	const source = ctx.mediaUrl;
	if (!source) return null;

	try {
		if (/^https?:\/\//i.test(source)) {
			const res = await fetch(source);
			if (!res.ok) return null;
			const buf = Buffer.from(await res.arrayBuffer());
			return {
				name: basename(new URL(source).pathname) || "attachment",
				content: buf.toString("base64"),
				contentType: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
			};
		}

		// Local path: the host's reader applies its own path policy, so prefer it.
		if (!ctx.mediaReadFile) return null;
		const buf = await ctx.mediaReadFile(source);
		return { name: basename(source) || "attachment", content: buf.toString("base64"), contentType: mimeFor(source) };
	} catch {
		return null;
	}
}

/** Same short table the core uses; duplicated here only for the URL-less local path. */
function mimeFor(path: string): string {
	const byExtension: Record<string, string> = {
		pdf: "application/pdf",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		csv: "text/csv",
		txt: "text/plain",
		json: "application/json",
		zip: "application/zip",
	};
	return byExtension[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** One send path, used by both the outbound adapter and the message adapter. */
async function sendMail(params: {
	to: string;
	text: string;
	accountId?: string | null;
	threadId?: string | number | null;
	replyToId?: string | null;
	attachments?: SendAttachment[];
}) {
	const runtime = getRuntime(params.accountId);
	if (!runtime) throw new Error("agentpost channel is not running");

	const threadId = params.threadId != null ? String(params.threadId) : (params.replyToId ?? null);
	const result = await runtime.send({
		to: params.to,
		text: params.text,
		threadId,
		attachments: params.attachments,
	});
	if (!result.success) throw new Error(result.error ?? "agentpost send failed");

	return {
		messageId: result.messageId ?? result.threadId ?? "",
		// "awaiting_approval" means the owner still has to release it.
		status: result.status ?? "sent",
		threadId: result.threadId,
	};
}

const base: Pick<ChannelPlugin<AgentpostAccount>, "id" | "meta" | "capabilities" | "config" | "gateway" | "message"> = {
	id: CHANNEL_ID,
	meta: {
		id: CHANNEL_ID,
		label: "Agentpost",
		selectionLabel: "Agentpost (email)",
		docsPath: "https://agentpost.no/docs",
		docsLabel: "agentpost.no/docs",
		blurb:
			"Give the agent its own email address. Inbound mail is sealed to the agent's key; the owner approves outbound.",
		markdownCapable: false,
	},
	capabilities: {
		chatTypes: ["direct"],
		reply: true,
		media: true,
		reactions: false,
		edit: false,
		unsend: false,
	},
	gateway: {
		startAccount,
		stopAccount,
	},
	// Without a message adapter the channel is not a valid target for the message tool
	// or `openclaw message send`; the outbound adapter alone only covers reply delivery.
	message: createChannelMessageAdapterFromOutbound({
		id: CHANNEL_ID,
		outbound: {
			// Declared here as well as on the outbound adapter: the message tool routes
			// through this one, and a channel that claims media must carry it on both.
			async sendMedia(ctx) {
				const attachment = await readMedia(ctx);
				const sent = await sendMail({
					to: ctx.to,
					text: ctx.text,
					accountId: ctx.accountId,
					threadId: ctx.threadId,
					replyToId: ctx.replyToId,
					attachments: attachment ? [attachment] : undefined,
				});
				return {
					channel: CHANNEL_ID,
					messageId: sent.messageId,
					target: { kind: "chat" as const, id: ctx.to },
					meta: { status: sent.status, threadId: sent.threadId },
				};
			},
			async sendText(ctx) {
				const sent = await sendMail({
					to: ctx.to,
					text: ctx.text,
					accountId: ctx.accountId,
					threadId: ctx.threadId,
					replyToId: ctx.replyToId,
				});
				// `outcome` is reserved for a provider-confirmed non-send; omitting it means sent.
				return {
					channel: CHANNEL_ID,
					messageId: sent.messageId,
					target: { kind: "chat" as const, id: ctx.to },
					meta: { status: sent.status, threadId: sent.threadId },
				};
			},
		},
	}),
	config: {
		listAccountIds,
		resolveAccount,
		inspectAccount,
		isEnabled: (account) => account.enabled,
		isConfigured: (account) => Boolean(account.username),
		unconfiguredReason: () => "Set channels.agentpost.username and channels.agentpost.ownerEmail.",
		describeAccount: (account) => ({
			accountId: account.accountId ?? "default",
			name: account.username ? `${account.username}@agentpost.no` : undefined,
			enabled: account.enabled,
			configured: Boolean(account.username),
			connected: getRuntime(account.accountId)?.connected() ?? false,
		}),
	},
};

export const agentpostChannelPlugin = createChatChannelPlugin<AgentpostAccount>({
	base,
	security: {
		dm: {
			channelKey: CHANNEL_ID,
			resolvePolicy: (account) => account.dmPolicy,
			resolveAllowFrom: (account) => account.allowFrom,
			// Anyone can write to an email address, so an unknown sender must not reach
			// the agent until the owner has listed them.
			defaultPolicy: "allowlist",
			// Suffixes make the doctor/setup hints point at the real config keys.
			policyPathSuffix: "dmPolicy",
			allowFromPathSuffix: "allowFrom",
			approveHint: "Add the address to channels.agentpost.allowFrom.",
			normalizeEntry: (raw) => raw.trim().toLowerCase(),
		},
	},
	threading: {
		topLevelReplyToMode: "reply",
	},
	outbound: {
		deliveryMode: "direct",
		// Plain text bodies: what the recipient's mail client shows, with the worker
		// adding the branded footer. Media becomes a real attachment, below.
		chunkerMode: "text",
		async sendText(ctx) {
			const sent = await sendMail({
				to: ctx.to,
				text: ctx.text,
				accountId: ctx.accountId,
				threadId: ctx.threadId,
				replyToId: ctx.replyToId,
			});
			return {
				channel: CHANNEL_ID,
				messageId: sent.messageId,
				target: { kind: "chat" as const, id: ctx.to },
				meta: { status: sent.status, threadId: sent.threadId },
			};
		},

		// Media sent through the conversation becomes a real attachment rather than a
		// link: a URL in an email is something the recipient has to trust and click.
		async sendMedia(ctx) {
			const attachment = await readMedia(ctx);
			const sent = await sendMail({
				to: ctx.to,
				text: ctx.text,
				accountId: ctx.accountId,
				threadId: ctx.threadId,
				replyToId: ctx.replyToId,
				attachments: attachment ? [attachment] : undefined,
			});
			return {
				channel: CHANNEL_ID,
				messageId: sent.messageId,
				target: { kind: "chat" as const, id: ctx.to },
				meta: { status: sent.status, threadId: sent.threadId, attached: String(Boolean(attachment)) },
			};
		},
	},
});
