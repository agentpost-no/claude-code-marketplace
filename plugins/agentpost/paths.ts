import { join } from "node:path";

/**
 * Storage root for keys, config, threads and the local inbox.
 *
 * Resolved lazily rather than at module load: a host that embeds this client (OpenClaw,
 * or any other MCP host) decides where its state lives, and only knows its state
 * directory once its own runtime has started. Every path is derived through a function
 * so there is no import-order hazard.
 *
 * Precedence: setStorageHome() > AGENTPOST_HOME > the Claude Code channel directory.
 */
let override: string | null = null;

export function setStorageHome(dir: string): void {
	override = dir;
}

export function storageHome(): string {
	return (
		override ??
		(process.env.AGENTPOST_HOME?.trim() || join(process.env.HOME ?? "~", ".claude", "channels", "agentpost"))
	);
}

export function keysDir(): string {
	return join(storageHome(), "keys");
}

export function attachmentsDir(): string {
	return join(storageHome(), "attachments");
}

export function configPath(): string {
	return join(storageHome(), "config.json");
}

export function threadsPath(): string {
	return join(storageHome(), "threads.json");
}

export function inboxPath(): string {
	return join(storageHome(), "inbox.json");
}
