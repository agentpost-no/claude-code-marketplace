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

	store.threads[threadId] = { threadId, ...context };
	if (context.messageId) {
		// Likewise for the index: an inbound Message-ID must not remap an id that already
		// points at an outbound thread.
		const mapped = store.messageIndex[context.messageId];
		const mappedThread = mapped ? store.threads[mapped] : undefined;
		if (!(mappedThread?.outbound === true && context.outbound !== true)) {
			store.messageIndex[context.messageId] = threadId;
		}
	}
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
