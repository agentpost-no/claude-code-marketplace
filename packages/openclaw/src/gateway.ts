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
				// Inbound mail informs the agent; it is not a thread anyone replies into.
				//
				// Nobody sits in an agentpost conversation - the owner talks to the agent
				// wherever they already do, in Telegram or WhatsApp or the web chat, and
				// this dispatch lands in that same session. Auto-delivering whatever the
				// agent said there straight back to the sender meant a remark meant for
				// the owner left as mail, and instructions smuggled into the email being
				// answered had an unattended path out.
				//
				// Replying is therefore a deliberate act: agentpost_reply, in the thread
				// the notification names.
				deliver: async () => {
					log.info("inbound mail is informational; replying is a deliberate agentpost_reply call");
				},
				onRecordError: (err) => log.error(`failed to record session: ${String(err)}`),
				onDispatchError: (err, info) => log.error(`${info.kind} dispatch failed: ${String(err)}`),
			});
			status({ running: true, connected: runtime.connected(), lastMessageAt: Date.now() });
		},

		async onNotice(text, meta) {
			// The agent should learn that its mail was delivered, bounced or approved -
			// the Claude Code plugin surfaces exactly this, and dropping it here made the
			// two hosts behave differently for no good reason.
			//
			// What must never happen is the notice sending mail. It used to be dispatched
			// with a deliver callback that emailed the owner, so every notice produced an
			// email, which produced its own delivery report, which produced another
			// notice: twenty messages in seven minutes before the server's rate limiter
			// stopped it. Deduplication could not fix that shape, because each report
			// carries the id of a *new* email.
			//
			// So the notice is dispatched, and `deliver` is a dead end. The agent reads
			// it; nothing it says in reply can reach the network. That is also how the
			// Claude Code side behaves: a notification is one-way, and sending requires a
			// deliberate tool call.
			if (!account.ownerEmail || !pluginApi) {
				log.info(`${meta.event ?? "status"}: ${text}`);
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
				// Derived from the event, so a re-sent notice is not a second turn.
				messageId: meta.id ?? `notice:${meta.event ?? "status"}`,
				// The worker authenticated this, not an arbitrary sender.
				inboundAccessAuthorized: true,
				// Deliberately inert. See above: this is the return path that looped.
				deliver: async () => {
					log.info("reply to a status notice is not sent; notices are one-way");
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
