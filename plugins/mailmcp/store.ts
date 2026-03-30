import { CONFIG_PATH } from "./paths.js";
import { loadJsonFile, saveJsonFile } from "./file-store.js";
import type { Config } from "./types.js";
import type { RegisterRequest, RegisterResponse } from "./protocol.js";

const DEFAULT_WORKER_URL = "https://mailmcp.omelhus.workers.dev";

export function loadConfig(): Config | null {
  return loadJsonFile<Config | null>(CONFIG_PATH, null);
}

export function saveConfig(config: Config): void {
  saveJsonFile(CONFIG_PATH, config);
}

export function getWorkerUrl(): string {
  return process.env.MAILMCP_WORKER_URL ?? DEFAULT_WORKER_URL;
}

export async function register(
  workerUrl: string,
  username: string,
  publicKey: string
): Promise<RegisterResponse> {
  const body: RegisterRequest = { username, publicKey };
  const res = await fetch(`${workerUrl}/register`, {
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
