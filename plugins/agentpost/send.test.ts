import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStorageHome, storageHome } from "./paths.js";
import { attachmentsFromPaths } from "./send.js";

/**
 * The refusal message is deliberately identical for "inside the key directory" and
 * "unreadable": distinguishing them is a filesystem oracle when the request to attach
 * can be authored by an inbound email.
 *
 * The private key is the one secret the product's central claim rests on: if it leaves
 * the machine, "the operator cannot read your inbound mail" stops being true.
 *
 * The instruction to attach a file can arrive inside an email - untrusted text the agent
 * is reading - and mail to a trusted contact or to the owner skips approval entirely. So
 * "the agent asked for it" is not evidence that a human decided anything.
 */
const home = mkdtempSync(join(tmpdir(), "agentpost-test-"));
setStorageHome(home);
mkdirSync(join(home, "keys"), { recursive: true });
writeFileSync(join(home, "keys", "private.key"), "SECRET KEY BYTES");
writeFileSync(join(home, "config.json"), '{"email":"a@b.no"}');

const outside = mkdtempSync(join(tmpdir(), "agentpost-ok-"));
writeFileSync(join(outside, "report.pdf"), "a normal attachment");

describe("attachmentsFromPaths", () => {
	it("refuses the private key", async () => {
		await expect(attachmentsFromPaths([join(home, "keys", "private.key")])).rejects.toThrow(/Cannot attach/);
	});

	it("refuses anything else inside the storage root", async () => {
		await expect(attachmentsFromPaths([join(home, "config.json")])).rejects.toThrow(/Cannot attach/);
		await expect(attachmentsFromPaths([storageHome()])).rejects.toThrow(/Cannot attach/);
	});

	it("refuses a symlink that points into the storage root", async () => {
		// A string comparison alone is defeated by a link, so the path is resolved first.
		const link = join(outside, "innocent-looking.txt");
		try {
			symlinkSync(join(home, "keys", "private.key"), link);
		} catch {
			return; // No symlink permission on this platform; the direct cases still cover it.
		}
		await expect(attachmentsFromPaths([link])).rejects.toThrow(/Cannot attach/);
	});

	it("refuses a traversal path that lands in the storage root", async () => {
		await expect(
			attachmentsFromPaths([join(outside, "..", ...home.split("/").slice(-1), "config.json")]),
		).rejects.toThrow();
	});

	it("still attaches an ordinary file", async () => {
		const [attachment] = await attachmentsFromPaths([join(outside, "report.pdf")]);
		expect(attachment.name).toBe("report.pdf");
		expect(attachment.contentType).toBe("application/pdf");
		expect(Buffer.from(attachment.content, "base64").toString()).toBe("a normal attachment");
	});

	it("caps how many files one message can carry", async () => {
		const many = Array.from({ length: 11 }, () => join(outside, "report.pdf"));
		await expect(attachmentsFromPaths(many)).rejects.toThrow(/Too many attachments/);
	});
});
