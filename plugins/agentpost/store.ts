import { loadJsonFile, saveJsonFile } from "./file-store.js";
import { configPath } from "./paths.js";
import type { RegisterRequest, RegisterResponse } from "./protocol.js";
import type { Config } from "./types.js";

const DEFAULT_WORKER_URL = "https://api.agentpost.no";

export function loadConfig(): Config | null {
	return loadJsonFile<Config | null>(configPath(), null);
}

export function saveConfig(config: Config): void {
	saveJsonFile(configPath(), config);
}

export function getWorkerUrl(): string {
	return process.env.AGENTPOST_WORKER_URL ?? DEFAULT_WORKER_URL;
}

/** Ask the worker whether owner verification has completed for this agent. */
export async function fetchStatus(workerUrl: string, agentId: string, publicKeyB64: string): Promise<string | null> {
	const res = await fetch(`${workerUrl}/api/status/${agentId}?pk=${encodeURIComponent(publicKeyB64)}`);
	if (!res.ok) return null;
	const data = (await res.json()) as { status?: string };
	return data.status ?? null;
}

export async function register(
	workerUrl: string,
	username: string,
	publicKey: string,
	displayName?: string,
	ownerEmail?: string,
): Promise<RegisterResponse> {
	const body: RegisterRequest = { username, publicKey, displayName, ownerEmail: ownerEmail ?? "" };
	const res = await fetch(`${workerUrl}/api/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Registration failed (${res.status}): ${text}`);
	}

	return (await res.json()) as RegisterResponse;
}
