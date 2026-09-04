import { readFile, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { storageHome } from "./paths.js";
import { lookupThread, signThread, storeThreadContext } from "./thread.js";

/** Outbound send over the worker REST API. Shared by every host adapter. */

export interface SendAttachment {
	name: string;
	content: string;
	contentType: string;
}

export interface SendParams {
	to: string;
	subject: string;
	body: string;
	html_body?: string;
	custom_headers?: Record<string, string>;
	footer_language?: "no" | "en";
	attachments?: SendAttachment[];
}

/**
 * Extension to MIME type. Deliberately a short list of what an agent actually attaches:
 * a wrong type on an unusual extension is worse than the octet-stream fallback, which
 * every mail client handles.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	csv: "text/csv",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	html: "text/html",
	xml: "application/xml",
	zip: "application/zip",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Never attachable, whatever asks: this is the secret the product's claim rests on. */
const MAX_ATTACHED_FILES = 10;

/**
 * Read local files into base64 attachments.
 *
 * Throws on the first unreadable path rather than sending a mail that is quietly
 * missing what the agent said it attached.
 *
 * The agent's own key directory is refused outright. The instruction to attach a file
 * can arrive inside an email - untrusted text the agent is reading - and a trusted
 * contact or the owner's address skips approval, so "the agent asked for it" is not
 * evidence that a human did. Symlinks are resolved before the check, because a link is
 * the obvious way around a string comparison.
 */
export async function attachmentsFromPaths(paths: readonly string[]): Promise<SendAttachment[]> {
	if (paths.length > MAX_ATTACHED_FILES) {
		throw new Error(`Too many attachments: ${paths.length}, limit is ${MAX_ATTACHED_FILES}`);
	}

	// Both sides must be resolved, not just the candidate. On macOS the storage root
	// often sits under /var, which is a symlink to /private/var: comparing a realpath'd
	// candidate against an unresolved root never matches, and the guard silently passes
	// everything. A test caught this; the guard had shipped broken.
	let protectedRoot = resolve(storageHome());
	try {
		protectedRoot = await realpath(protectedRoot);
	} catch {
		// The directory may not exist yet on a first run; the unresolved form still
		// blocks the common case.
	}

	const out: SendAttachment[] = [];
	for (const filePath of paths) {
		let resolved = resolve(filePath);
		try {
			resolved = await realpath(resolved);
		} catch {
			// Missing file: fall through to readFile, which reports it properly.
		}
		if (resolved === protectedRoot || resolved.startsWith(protectedRoot + sep)) {
			throw new Error(`Refusing to attach ${filePath}: it is inside the agentpost key and state directory`);
		}

		let buf: Buffer;
		try {
			buf = await readFile(resolved);
		} catch (err) {
			throw new Error(`Failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
		out.push({
			name: basename(resolved),
			content: buf.toString("base64"),
			contentType: MIME_BY_EXTENSION[ext] ?? "application/octet-stream",
		});
	}
	return out;
}

export interface SendContext {
	workerUrl: string;
	username: string;
	/** Short-lived access token from the WebSocket auth handshake. */
	accessToken: string | null;
}

export interface SendResult {
	success: boolean;
	messageId?: string;
	error?: string;
	/** "awaiting_approval" when the owner still has to approve the send. */
	status?: string;
	requestId?: string;
}

export async function sendViaRest(params: SendParams, ctx: SendContext): Promise<SendResult> {
	if (!ctx.accessToken) {
		return { success: false, error: "No access token. Wait for WebSocket authentication." };
	}

	try {
		const res = await fetch(`${ctx.workerUrl}/api/agents/${ctx.username}/send`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ctx.accessToken}`,
			},
			body: JSON.stringify(params),
		});
		return (await res.json()) as SendResult;
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : "REST send failed" };
	}
}

/**
 * Send a new email and record it as an outbound thread, returning the thread id the
 * agent uses to follow up. Thread ids are HMAC-signed locally so an inbound reply
 * cannot forge one.
 */
export async function sendNewEmail(
	params: Omit<SendParams, "custom_headers"> & { on_behalf_of?: string },
	ctx: SendContext & { fromAddress: string; hmacKey: Uint8Array },
): Promise<SendResult & { threadId: string }> {
	const nonce = crypto.randomUUID();
	const timestamp = new Date().toISOString();
	const threadId = signThread(ctx.hmacKey, {
		from: ctx.fromAddress,
		to: params.to,
		subject: params.subject,
		timestamp,
		nonce,
	});

	const custom_headers: Record<string, string> = {
		"X-Agentpost-Thread-Id": threadId,
		"X-Agentpost-Nonce": nonce,
	};
	if (params.on_behalf_of) custom_headers["X-Agentpost-On-Behalf-Of"] = params.on_behalf_of;

	const { on_behalf_of: _omit, ...rest } = params;
	const result = await sendViaRest({ ...rest, custom_headers }, ctx);

	if (result.success) {
		storeThreadContext(threadId, {
			to: params.to,
			subject: params.subject,
			body: params.body,
			timestamp,
			messageId: result.messageId,
			outbound: true,
		});
	}

	return { ...result, threadId };
}

/** Reply inside an existing thread, keeping In-Reply-To so the mail client threads it. */
export async function replyToThread(
	threadId: string,
	body: string,
	ctx: SendContext,
): Promise<SendResult & { to?: string; subject?: string }> {
	const thread = lookupThread(threadId);
	if (!thread) return { success: false, error: `Thread not found: ${threadId}` };

	const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;
	const result = await sendViaRest(
		{
			to: thread.to,
			subject,
			body,
			custom_headers: {
				"X-Agentpost-Thread-Id": threadId,
				...(thread.messageId ? { "In-Reply-To": thread.messageId } : {}),
			},
		},
		ctx,
	);

	if (result.success) {
		storeThreadContext(threadId, {
			to: thread.to,
			subject,
			body,
			timestamp: new Date().toISOString(),
			messageId: result.messageId,
			outbound: true,
		});
	}

	return { ...result, to: thread.to, subject };
}
