import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const CHANNEL_ID = "agentpost";
export const DEFAULT_WORKER_URL = "https://api.agentpost.no";
export const DEFAULT_ACCOUNT_ID = "default";

/** One agentpost identity: a registered username and the worker it talks to. */
export interface AgentpostAccount {
	accountId?: string | null;
	enabled: boolean;
	workerUrl: string;
	/** Registered username; the address is `${username}@agentpost.no`. */
	username?: string;
	/** Storage root for keys, threads and the local inbox. Defaults to the state dir. */
	home?: string;
	/** Owner address. Receives the verification link on first registration. */
	ownerEmail?: string;
	/** Display name shown in the From field. Defaults to the capitalized username. */
	displayName?: string;
	dmPolicy?: string;
	allowFrom?: string[];
}

interface RawAccount {
	enabled?: boolean;
	workerUrl?: string;
	username?: string;
	home?: string;
	ownerEmail?: string;
	displayName?: string;
	dmPolicy?: string;
	allowFrom?: string[];
	accounts?: Record<string, Omit<RawAccount, "accounts">>;
}

function rawChannelConfig(cfg: OpenClawConfig): RawAccount {
	const channels = (cfg as { channels?: Record<string, unknown> }).channels;
	const raw = channels?.[CHANNEL_ID];
	return (raw && typeof raw === "object" ? (raw as RawAccount) : {}) satisfies RawAccount;
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
	const raw = rawChannelConfig(cfg);
	const named = Object.keys(raw.accounts ?? {});
	// The unnamed top-level block is the default account; named ones sit beside it.
	return named.length > 0 && raw.username === undefined ? named : [DEFAULT_ACCOUNT_ID, ...named];
}

export function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): AgentpostAccount {
	const raw = rawChannelConfig(cfg);
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const scoped = id === DEFAULT_ACCOUNT_ID ? raw : (raw.accounts?.[id] ?? {});

	return {
		accountId: id,
		// A channel with no explicit `enabled` is on as soon as it is configured;
		// an explicit false always wins.
		enabled: scoped.enabled ?? raw.enabled ?? true,
		workerUrl: (scoped.workerUrl ?? raw.workerUrl ?? DEFAULT_WORKER_URL).replace(/\/+$/, ""),
		username: scoped.username ?? (id === DEFAULT_ACCOUNT_ID ? raw.username : undefined),
		home: scoped.home ?? raw.home,
		ownerEmail: scoped.ownerEmail ?? raw.ownerEmail,
		displayName: scoped.displayName ?? raw.displayName,
		dmPolicy: scoped.dmPolicy ?? raw.dmPolicy,
		allowFrom: scoped.allowFrom ?? raw.allowFrom,
	};
}

export function inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
	const account = resolveAccount(cfg, accountId);
	return {
		enabled: account.enabled,
		configured: Boolean(account.username),
		username: account.username,
		workerUrl: account.workerUrl,
	};
}

/** The agent's own address. Only meaningful once a username is registered. */
export function accountAddress(account: AgentpostAccount): string | undefined {
	return account.username ? `${account.username}@agentpost.no` : undefined;
}
