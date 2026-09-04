import { createRequire } from "node:module";
import { hmac } from "./crypto.js";
import { loadJsonFile, saveJsonFile } from "./file-store.js";
import { threadsPath } from "./paths.js";
import type { ThreadContext, ThreadSignInput } from "./types.js";

// Readiness is guaranteed by initSodium() in crypto.ts, awaited during startup.
const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo");

interface ThreadStore {
	threads: Record<string, ThreadContext>;
	messageIndex: Record<string, string>;
}

const EMPTY_STORE: ThreadStore = { threads: {}, messageIndex: {} };

/**
 * Caps on what threads.json retains.
 *
 * The whole file is parsed on first use and fully re-serialised on every stored context,
 * so unbounded growth is quadratic in message count, and the body field held the entire
 * converted message forever. Sixty inbound mails with 200 KB bodies produced a 12 MB file
 * rewritten on every subsequent mail; the server accepts messages up to 25 MB. The inbox
 * has always capped itself at 200 entries - this brings threads.json in line.
 *
 * Bodies are kept only as reply context, so a truncated one still serves its purpose.
 */
const MAX_THREADS = 500;
const MAX_BODY_CHARS = 8000;

/**
 * Drop the oldest threads once over the cap, preferring to keep outbound records: those
 * are the agent's own trusted memory of what it sent, and they decide where a reply is
 * addressed. Inbound records only supply context and can be re-fetched from the inbox.
 */
function evict(store: ThreadStore): void {
	const ids = Object.keys(store.threads);
	if (ids.length <= MAX_THREADS) return;

	const ranked = ids
		.map((id) => {
			const t = store.threads[id];
			return { id, outbound: t.outbound === true, at: Date.parse(t.timestamp ?? "") || 0 };
		})
		.sort((a, b) => {
			if (a.outbound !== b.outbound) return a.outbound ? 1 : -1;
			return a.at - b.at;
		});

	for (const { id } of ranked.slice(0, ids.length - MAX_THREADS)) {
		delete store.threads[id];
	}

	for (const [messageId, threadId] of Object.entries(store.messageIndex)) {
		if (!store.threads[threadId]) delete store.messageIndex[messageId];
	}
}

// In-memory cache - loaded once, written on mutation
let cache: ThreadStore | null = null;

function getStore(): ThreadStore {
	if (!cache) {
		cache = loadJsonFile<ThreadStore>(threadsPath(), EMPTY_STORE);
	}
	return cache;
}

function persist(): void {
	if (cache) saveJsonFile(threadsPath(), cache);
}

export function signThread(hmacKey: Uint8Array, input: ThreadSignInput): string {
	const message = `${input.from}\0${input.to}\0${input.subject}\0${input.timestamp}\0${input.nonce}`;
	const tag = hmac(hmacKey, new TextEncoder().encode(message));
	return sodium.to_hex(tag);
}

export function storeThreadContext(threadId: string, context: Omit<ThreadContext, "threadId">): void {
	const store = getStore();

	// An outbound record is the only trusted memory of what this agent actually sent, and
	// it decides where a reply is addressed. Inbound mail must never replace one: the
	// outbound thread id travels in a header, so a recipient can learn it and send a
	// reply that claims to be that thread. Overwriting would repoint the agent's replies
	// at whoever wrote in, and destroy the record that formatEmailContent trusts.
	const existing = store.threads[threadId];
	if (existing?.outbound === true && context.outbound !== true) {
		return;
	}

	store.threads[threadId] = {
		threadId,
		...context,
		body: context.body.length > MAX_BODY_CHARS ? `${context.body.slice(0, MAX_BODY_CHARS)}\n[truncated]` : context.body,
	};
	if (context.messageId) {
		// Likewise for the index: an inbound Message-ID must not remap an id that already
		// points at an outbound thread.
		const mapped = store.messageIndex[context.messageId];
		const mappedThread = mapped ? store.threads[mapped] : undefined;
		if (!(mappedThread?.outbound === true && context.outbound !== true)) {
			store.messageIndex[context.messageId] = threadId;
		}
	}
	evict(store);
	persist();
}

export function lookupThread(messageIdOrThreadId: string): ThreadContext | null {
	const store = getStore();

	if (store.threads[messageIdOrThreadId]) {
		return store.threads[messageIdOrThreadId];
	}

	const threadId = store.messageIndex[messageIdOrThreadId];
	if (threadId && store.threads[threadId]) {
		return store.threads[threadId];
	}

	return null;
}

/** Return Message-IDs for emails we sent (outbound only) for thread claim. */
export function getAllMessageIds(): string[] {
	const store = getStore();
	return Object.entries(store.messageIndex)
		.filter(([_, threadId]) => store.threads[threadId]?.outbound === true)
		.map(([messageId]) => messageId);
}
