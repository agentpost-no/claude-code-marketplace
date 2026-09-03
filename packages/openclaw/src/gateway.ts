import { join } from "node:path";
import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { type AgentpostAccount, accountAddress, CHANNEL_ID } from "./account.js";
import { deleteRuntime, setRuntime } from "./registry.js";
import { createMailRuntime } from "./runtime.js";

const CHANNEL_LABEL = "Agentpost";

/**
 * Channel lifecycle: OpenClaw starts and stops one connection per enabled account.
 *
 * This is the gateway adapter rather than a plugin service on purpose - the health
 * monitor reads the status set here, and restarts an account it believes has stopped.
 */

/** Captured during register(api); the inbound dispatcher needs the plugin runtime. */
let pluginApi: OpenClawPluginApi | null = null;

export function setPluginApi(api: OpenClawPluginApi): void {
	pluginApi = api;
}

/** Derived from the SDK so the adapter cannot drift from the host contract. */
type GatewayContext = Parameters<
	NonNullable<NonNullable<ChannelPlugin<AgentpostAccount>["gateway"]>["startAccount"]>
>[0];

export async function startAccount(ctx: GatewayContext): Promise<void> {
	const { accountId, cfg } = ctx;
	const prefix = `[agentpost:${accountId}]`;
	const log = {
		info: (m: string) => ctx.log?.info?.(`${prefix} ${m}`),
		warn: (m: string) => ctx.log?.warn?.(`${prefix} ${m}`),
		error: (m: string) => ctx.log?.error?.(`${prefix} ${m}`),
	};

	// Each account keeps its own storage root: the keypair is the identity, so two
	// accounts sharing a directory would share an inbox.
	const account: AgentpostAccount = {
		...ctx.account,
		accountId,
		home: ctx.account.home ?? join(resolveStateDir(), "agentpost", accountId),
	};

	const status = (patch: Record<string, unknown>) => {
		ctx.setStatus({ ...ctx.getStatus(), ...patch, accountId });
	};

	const runtime = createMailRuntime(account, {
		log,

		onConnectionChange(connected) {
			status({
				running: true,
				connected,
				...(connected ? { lastConnectedAt: Date.now() } : {}),
			});
		},

		async onMail(item) {
			if (!pluginApi) throw new Error("agentpost plugin api unavailable");
			await dispatchInboundDirectDmWithRuntime({
				cfg,
				runtime: pluginApi.runtime,
				channel: CHANNEL_ID,
				channelLabel: CHANNEL_LABEL,
				accountId,
				peer: { kind: "direct", id: item.from },
				senderId: item.from,
				senderAddress: item.from,
				recipientAddress: accountAddress(account) ?? runtime.address() ?? "",
				conversationLabel: item.subject,
				// Already wrapped in UNTRUSTED EXTERNAL CONTENT markers by the core.
				rawBody: item.content,
				// The reply thread id doubles as the platform message id, so an agent
				// reply routes back into the same email thread.
				messageId: item.replyThreadId,
				timestamp: Date.parse(item.receivedAt) || undefined,
				deliver: async (payload) => {
					const text = payload.text?.trim();
					if (!text) return;
					const sent = await runtime.send({ to: item.from, text, threadId: item.replyThreadId });
					if (!sent.success) throw new Error(sent.error ?? "reply failed");
				},
				onRecordError: (err) => log.error(`failed to record session: ${String(err)}`),
				onDispatchError: (err, info) => log.error(`${info.kind} dispatch failed: ${String(err)}`),
			});
			status({ running: true, connected: runtime.connected(), lastMessageAt: Date.now() });
		},

		async onNotice(text, meta) {
			// Delivery reports and approval results come from our own worker over an
			// authenticated socket, so they are not wrapped as untrusted. They are
			// dispatched as if from the owner, which is also where a reply belongs.
			if (!account.ownerEmail || !pluginApi) {
				log.info(text);
				return;
			}
			await dispatchInboundDirectDmWithRuntime({
				cfg,
				runtime: pluginApi.runtime,
				channel: CHANNEL_ID,
				channelLabel: CHANNEL_LABEL,
				accountId,
				peer: { kind: "direct", id: account.ownerEmail },
				senderId: account.ownerEmail,
				senderAddress: account.ownerEmail,
				recipientAddress: accountAddress(account) ?? runtime.address() ?? "",
				conversationLabel: "Agentpost status",
				rawBody: text,
				// Stable id from the event itself, so a re-sent notice is not a new turn.
				messageId: meta.id ?? `notice:${meta.event ?? "status"}`,
				// The worker authenticated this, not an arbitrary sender.
				inboundAccessAuthorized: true,
				deliver: async (payload) => {
					const body = payload.text?.trim();
					if (!body || !account.ownerEmail) return;
					const sent = await runtime.send({ to: account.ownerEmail, text: body });
					if (!sent.success) throw new Error(sent.error ?? "reply failed");
				},
				onRecordError: (err) => log.error(`failed to record session: ${String(err)}`),
				onDispatchError: (err, info) => log.error(`${info.kind} dispatch failed: ${String(err)}`),
			});
		},
	});

	setRuntime(accountId, runtime);
	// Running before connected: the socket retries on its own, and reporting "stopped"
	// while it waits for owner verification would have the health monitor restart it.
	status({ running: true, connected: false, configured: Boolean(account.username) });

	await runtime.start();
	status({ running: true, connected: runtime.connected(), name: runtime.address() });

	// startAccount owns the account for as long as it is running: returning early reads
	// as "channel exited" to the host and triggers its auto-restart loop. Stay pending
	// until the host aborts, then tear the socket down.
	await waitUntilAbort(ctx.abortSignal, () => {
		runtime.stop();
		deleteRuntime(accountId);
		status({ running: false, connected: false });
	});
}

export async function stopAccount(ctx: GatewayContext): Promise<void> {
	deleteRuntime(ctx.accountId)?.stop();
	ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: false, connected: false });
}
