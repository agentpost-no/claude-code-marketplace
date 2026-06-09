import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadJsonFile<T>(path: string, defaultValue: T): T {
	if (!existsSync(path)) return defaultValue;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// The file exists but is not parseable (e.g. a write was interrupted mid-flush).
		// Preserve it as .bad instead of silently discarding it - the next save would
		// otherwise overwrite the only recoverable copy with the default value.
		try {
			renameSync(path, `${path}.bad`);
		} catch {
			// Best-effort backup; fall through to the default either way.
		}
		return defaultValue;
	}
}

export function saveJsonFile<T>(path: string, data: T): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Write to a temp file then atomically rename into place, so a crash mid-write can
	// never leave a truncated/invalid JSON file (rename is atomic on POSIX).
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}
