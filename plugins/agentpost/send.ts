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

const MAX_ATTACHED_FILES = 10;

/**
 * Directories whose contents are never attachable, whatever asks.
 *
 * The storage home is checked separately (it holds the private key the product's whole
 * claim rests on). These are the other places a machine keeps credentials. The point is
 * not that this list is complete - it cannot be - but that the obvious targets of "please
 * attach your credentials" do not work, since that instruction can arrive inside an email
 * and mail to the owner or a trusted contact skips approval entirely.
 *
 * In Claude Code this is defence in depth: the host's own file tools can read anything and
 * hand it to the base64 `attachments` parameter, which no guard covers. OpenClaw exposes
 * no path parameter at all, which is the better shape. Owner approval remains the real
 * control.
 */
const PROTECTED_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gcloud"];

/** Filenames that are credentials wherever they sit. */
const PROTECTED_FILES = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|p12|pfx|keystore))$/i;

/**
 * Read local files into base64 attachments.
 *
 * Throws on the first unreadable path rather than sending a mail that is quietly
 * missing what the agent said it attached.
 *
 * The agent's own key directory is refused outright, as are the usual credential stores
 * (PROTECTED_DIRS / PROTECTED_FILES). The instruction to attach a file can arrive inside
 * an email - untrusted text the agent is reading - and a trusted contact or the owner's
 * address skips approval, so "the agent asked for it" is not evidence that a human did.
 * Symlinks are resolved before the check, because a link is the obvious way around a
 * string comparison.
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
		const segments = resolved.split(sep);
		const inProtectedDir = PROTECTED_DIRS.some((dir) => {
			const parts = dir.split("/");
			return segments.some((_, i) => parts.every((part, j) => segments[i + j] === part));
		});

		if (
			resolved === protectedRoot ||
			resolved.startsWith(protectedRoot + sep) ||
			inProtectedDir ||
			PROTECTED_FILES.test(basename(resolved))
		) {
			// No path in the message: the refusal itself is the answer, and the reason is
			// for the log. Distinguishing "inside the key directory" from "missing" tells
			// a prober where things are, and the prober can be an email.
			throw new Error(`Cannot attach ${basename(filePath)}`);
		}

		let buf: Buffer;
		try {
			buf = await readFile(resolved);
		} catch {
			// Deliberately no errno and no path: ENOENT versus EACCES versus EISDIR is a
			// filesystem oracle when the request can be authored by an inbound email.
			throw new Error(`Cannot attach ${basename(filePath)}`);
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

/**
 * Local ceiling on outbound sends, and a refusal to mail the agent itself.
 *
 * The server rate-limits too, but that protects the server: by the time it refuses, the
 * mail has already been sent. A notice loop reached twenty messages in seven minutes
 * before the server stopped it, and mail addressed to the agent's own address is the
 * shape every such loop takes - the reply arrives as new inbound and produces another.
 *
 * State is per-process, which is the right scope: each host runs one agent identity.
 */
const SEND_WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 8;
const sendTimes: number[] = [];

export function guardSend(
	to: string,
	ownAddress: string | undefined,
	log?: (m: string) => void,
): { success: false; error: string } | null {
	if (ownAddress && to.trim().toLowerCase() === ownAddress.toLowerCase()) {
		const error = "refusing to send to the agent's own address";
		log?.(error);
		return { success: false, error };
	}

	const now = Date.now();
	while (sendTimes.length > 0 && now - sendTimes[0] > SEND_WINDOW_MS) sendTimes.shift();
	if (sendTimes.length >= MAX_SENDS_PER_WINDOW) {
		const error = `local send limit reached (${MAX_SENDS_PER_WINDOW} per minute); refusing to send`;
		log?.(error);
		return { success: false, error };
	}
	sendTimes.push(now);
	return null;
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
 * agent uses to follow up.
 *
 * The thread id is an HMAC tag, but nothing verifies it and nothing should read that as
 * a security property: it is used only as an opaque, unguessable lookup key, and a random
 * UUID would serve identically. What actually stops an inbound reply from claiming an
 * outbound thread is the write-once guard in thread.ts (an inbound record can never
 * replace an outbound one) plus keying inbound threads on the server-assigned id rather
 * than the sender's own Message-ID.
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
