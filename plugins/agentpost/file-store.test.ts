import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJsonFile, saveJsonFile } from "./file-store.js";

/**
 * Two Claude Code sessions both run this MCP server against the same default storage
 * home, so concurrent writers are the ordinary configuration rather than an exotic one.
 *
 * With a fixed `${path}.tmp` their writeFileSync calls (O_TRUNC) interleave and the
 * atomic rename then publishes mixed bytes. The direction that matters is inbox.json:
 * loadJsonFile resets a corrupt file, which loses the dedupe set, and mail.ts relies on
 * that set to avoid giving the agent a second turn for one email. Corruption there is
 * fail-open.
 */
describe("saveJsonFile", () => {
	const dir = mkdtempSync(join(tmpdir(), "agentpost-fs-"));

	it("round-trips and leaves no temp file behind", () => {
		const path = join(dir, "store.json");
		saveJsonFile(path, { a: 1, æøå: "Norwegian" });
		expect(loadJsonFile<Record<string, unknown>>(path, {})).toEqual({ a: 1, æøå: "Norwegian" });
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("survives concurrent writers from separate processes", async () => {
		const path = join(dir, "concurrent.json");
		const script = join(dir, "writer.ts");
		writeFileSync(
			script,
			`import { saveJsonFile } from ${JSON.stringify(join(import.meta.dir, "file-store.ts"))};
const [, , target, tag] = process.argv;
// Payloads of very different sizes: interleaved O_TRUNC writes of unequal length are
// what produce trailing garbage from the longer write after the shorter one renames.
const payload = tag === "big" ? "x".repeat(400_000) : "y";
for (let i = 0; i < 40; i++) saveJsonFile(target, { tag, i, payload });
`,
		);

		await Promise.all(
			["big", "small"].map(
				(tag) =>
					new Promise<void>((resolve, reject) => {
						const proc = Bun.spawn(["bun", script, path, tag], { stdout: "ignore", stderr: "pipe" });
						proc.exited.then((code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}`))));
					}),
			),
		);

		// The file must be parseable and be exactly one writer's record - never a splice of
		// both. Whose record wins is last-writer-wins and not something this test pins.
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as { tag: string; payload: string };
		expect(["big", "small"]).toContain(parsed.tag);
		expect(parsed.payload.length).toBe(parsed.tag === "big" ? 400_000 : 1);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	}, 30_000);
});
