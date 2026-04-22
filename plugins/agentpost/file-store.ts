import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadJsonFile<T>(path: string, defaultValue: T): T {
	if (!existsSync(path)) return defaultValue;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return defaultValue;
	}
}

export function saveJsonFile<T>(path: string, data: T): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const existed = existsSync(path);
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
	if (existed) chmodSync(path, 0o600);
}
