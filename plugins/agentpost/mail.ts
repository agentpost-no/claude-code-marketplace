import { fromBase64, sealedBoxDecrypt } from "./crypto.js";
import { escapeUntrusted, formatEmailContent, parseEmail, saveAttachments } from "./email-parser.js";
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

		// Key inbound threads on the server-assigned id, never on the sender's own
		// Message-ID. That header is attacker-controlled, and the agent's outbound thread
		// ids travel in a header the recipient can read - so keying on it let a reply
		// name an existing thread and take it over. The Message-ID is still recorded
		// below as the In-Reply-To value, which is what it is actually for.
		const replyThreadId = `in:${encrypted.id}`;
		// Normalise before it enters the store, not just before it is rendered. Replying
		// carries this subject forward into an outbound record (send.ts replyToThread), and
		// an outbound record renders inside the trusted block - so a subject holding raw
		// newlines becomes multi-line text attributed to the agent itself. A mail subject
		// cannot legally contain them anyway; postal-mime decodes RFC 2047 words that can.
		storeThreadContext(replyThreadId, {
			to: escapeUntrusted(email.from).slice(0, 320),
			subject: escapeUntrusted(email.subject).slice(0, 320),
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
		//
		// A false here means the server is redelivering something already handled - the
		// ack is silently dropped when the socket is not open, which is exactly the state
		// during a reconnect mid-drain. Delivering again would give the agent a second
		// turn for one email, so only the ack is repeated.
		const isNew = appendInboxEntry({
			id: encrypted.id,
			kind: "email",
			receivedAt: encrypted.receivedAt,
			meta,
			content,
		});
		if (!isNew) {
			log(`Email ${encrypted.id} was already handled; re-acking without delivering again.`);
			deps.ack(encrypted.id);
			return;
		}

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
