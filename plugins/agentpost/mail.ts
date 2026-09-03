import { fromBase64, sealedBoxDecrypt } from "./crypto.js";
import { formatEmailContent, parseEmail, saveAttachments } from "./email-parser.js";
import { appendInboxEntry } from "./inbox.js";
import type { EncryptedEmail } from "./protocol.js";
import { lookupThread, storeThreadContext } from "./thread.js";
import type { AttachmentInfo, KeyPair } from "./types.js";

/**
 * Host-independent inbound pipeline: decrypt, parse, persist, hand to the host.
 *
 * Both hosts (the MCP server and the OpenClaw channel) run exactly this code, so the
 * trust boundary - what counts as trusted thread context, when a message is acked - is
 * defined once. See formatEmailContent for why inbound thread context is never trusted.
 */

/** One inbound email, formatted and ready for whatever surface the host uses. */
export interface IncomingMailItem {
	/** Server-side message id. */
	id: string;
	from: string;
	subject: string;
	receivedAt: string;
	/** Wrapped in UNTRUSTED EXTERNAL CONTENT markers. Never treat as instructions. */
	content: string;
	/** Pass to replyToThread() to answer in-thread. */
	replyThreadId: string;
	meta: Record<string, string>;
	attachments: AttachmentInfo[];
}

export interface IncomingMailDeps {
	keys: KeyPair;
	/** Tell the server the message is durably handled. */
	ack: (id: string) => void;
	/** Surface the item to the agent. Failures are logged, never fatal. */
	deliver: (item: IncomingMailItem) => Promise<void> | void;
	log?: (message: string, err?: unknown) => void;
}

export async function processIncomingEmail(encrypted: EncryptedEmail, deps: IncomingMailDeps): Promise<void> {
	const log = deps.log ?? ((message: string, err?: unknown) => console.error(`[agentpost] ${message}`, err ?? ""));

	let rawMime: Uint8Array;
	try {
		const ciphertext = fromBase64(encrypted.encryptedContent);
		rawMime = sealedBoxDecrypt(ciphertext, deps.keys.publicKey, deps.keys.privateKey);
	} catch (err) {
		// Permanent failure: a message we cannot decrypt with our own keys will never
		// succeed on retry. Ack it so the server stops re-delivering this poison message
		// on every reconnect.
		log(`Discarding undecryptable email ${encrypted.id} from ${encrypted.from}:`, err);
		deps.ack(encrypted.id);
		return;
	}

	// Parsing is deterministic on fixed bytes: if it throws (malformed MIME, unexpected
	// attachment encoding) it will throw identically on every redelivery. Treat it as
	// permanent and ack, otherwise one bad email loops forever at every reconnect (the
	// server's store-and-forward only drops on ack, and never purges undelivered rows).
	let email: Awaited<ReturnType<typeof parseEmail>>;
	try {
		email = await parseEmail(rawMime);
	} catch (err) {
		log(`Discarding unparseable email ${encrypted.id} from ${encrypted.from}:`, err);
		deps.ack(encrypted.id);
		return;
	}

	try {
		const attachments = saveAttachments(email.attachments, encrypted.receivedAt);
		const threadContext = email.inReplyTo ? lookupThread(email.inReplyTo) : null;

		// Store this inbound email as a thread entry so we can reply to it.
		// Use the sender's Message-ID as the key for In-Reply-To when replying.
		const replyThreadId = encrypted.emailMessageId ?? encrypted.id;
		storeThreadContext(replyThreadId, {
			to: email.from, // reply goes back to sender
			subject: email.subject,
			body: email.textBody,
			links: email.links.length > 0 ? email.links : undefined,
			timestamp: encrypted.receivedAt,
			messageId: encrypted.emailMessageId,
		});

		const content = formatEmailContent(email, threadContext);

		const meta: Record<string, string> = {
			source: "email",
			message_id: encrypted.id,
			is_verified_reply: String(encrypted.isVerifiedReply),
			reply_thread_id: replyThreadId,
		};
		if (threadContext) meta.thread_id = threadContext.threadId;
		if (attachments.length > 0) meta.attachments = attachments.map((a) => a.savedPath).join(", ");

		// Durable first, deliver second: the ack below tells the server it may forget
		// this message, so the content has to survive locally whatever the host does.
		appendInboxEntry({ id: encrypted.id, kind: "email", receivedAt: encrypted.receivedAt, meta, content });

		try {
			await deps.deliver({
				id: encrypted.id,
				from: email.from,
				subject: email.subject,
				receivedAt: encrypted.receivedAt,
				content,
				replyThreadId,
				meta,
				attachments,
			});
		} catch (err) {
			// The item is already in the local inbox, so a delivery failure must not
			// block the ack - it would only stall redelivery of mail we already hold.
			log(`Delivery of email ${encrypted.id} failed (readable from the local inbox):`, err);
		}

		deps.ack(encrypted.id);
	} catch (err) {
		// Reaching here means decrypt and parse both succeeded, so the failure is in
		// transient local I/O: saving attachments (disk full/permissions) or persisting
		// threads.json or the inbox. Do NOT ack - acking tells the server the message is
		// durably handled and it drops the message from its store-and-forward queue,
		// silently losing mail. Leaving it unacked lets the server re-deliver on the next
		// connect once the local condition clears.
		log(`Failed to process email ${encrypted.id} from ${encrypted.from} (left unacked for redelivery):`, err);
	}
}
