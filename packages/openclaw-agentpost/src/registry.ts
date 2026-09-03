import { DEFAULT_ACCOUNT_ID } from "./account.js";
import type { MailRuntime } from "./runtime.js";

/**
 * Live runtimes by account id.
 *
 * The outbound adapter is a plain object with no access to the plugin api, so the
 * running connection has to be reachable from module scope. The service owns the
 * lifetime; everything else only looks up.
 */
const runtimes = new Map<string, MailRuntime>();

export function setRuntime(accountId: string, runtime: MailRuntime): void {
	runtimes.set(accountId, runtime);
}

export function getRuntime(accountId?: string | null): MailRuntime | undefined {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	return runtimes.get(id) ?? runtimes.get(DEFAULT_ACCOUNT_ID);
}

export function listRuntimes(): Array<[string, MailRuntime]> {
	return [...runtimes.entries()];
}

export function clearRuntimes(): void {
	runtimes.clear();
}
