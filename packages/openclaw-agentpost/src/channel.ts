import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { type AgentpostAccount, CHANNEL_ID, inspectAccount, listAccountIds, resolveAccount } from "./account.js";
import { getRuntime } from "./registry.js";

/**
 * The agentpost channel.
 *
 * A direct-message channel whose peers are email addresses. Outbound goes through the
 * worker, which holds it for owner approval unless the contact is already trusted, so
 * there is deliberately no local approval seam here.
 */

/** Required surfaces of a channel plugin: identity, capabilities and account config. */
const base: Pick<ChannelPlugin<AgentpostAccount>, "id" | "meta" | "capabilities" | "config"> = {
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
		media: false,
		reactions: false,
		edit: false,
		unsend: false,
	},
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
		// Plain text only: the body is what the recipient's mail client shows, and the
		// worker adds the branded footer.
		chunkerMode: "text",
		async sendText(ctx) {
			const runtime = getRuntime(ctx.accountId);
			if (!runtime) throw new Error("agentpost channel is not running");

			const threadId = ctx.threadId != null ? String(ctx.threadId) : (ctx.replyToId ?? null);
			const result = await runtime.send({ to: ctx.to, text: ctx.text, threadId });
			if (!result.success) throw new Error(result.error ?? "agentpost send failed");

			return {
				channel: CHANNEL_ID,
				messageId: result.messageId ?? result.threadId ?? "",
				target: { kind: "chat" as const, id: ctx.to },
				meta: {
					// "awaiting_approval" means the owner still has to release it.
					status: result.status ?? "sent",
					threadId: result.threadId,
				},
			};
		},
	},
});
