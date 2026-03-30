import { createRequire } from "node:module";
import { THREADS_PATH } from "./paths.js";
import { loadJsonFile, saveJsonFile } from "./file-store.js";
import { hmac } from "./crypto.js";
import type { ThreadContext, ThreadSignInput } from "./types.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo");
await sodium.ready;

interface ThreadStore {
  threads: Record<string, ThreadContext>;
  messageIndex: Record<string, string>;
}

const EMPTY_STORE: ThreadStore = { threads: {}, messageIndex: {} };

// In-memory cache - loaded once, written on mutation
let cache: ThreadStore | null = null;

function getStore(): ThreadStore {
  if (!cache) {
    cache = loadJsonFile<ThreadStore>(THREADS_PATH, EMPTY_STORE);
  }
  return cache;
}

function persist(): void {
  if (cache) saveJsonFile(THREADS_PATH, cache);
}

export function signThread(hmacKey: Uint8Array, input: ThreadSignInput): string {
  const message = `${input.from}\0${input.to}\0${input.subject}\0${input.timestamp}\0${input.nonce}`;
  const tag = hmac(hmacKey, new TextEncoder().encode(message));
  return sodium.to_hex(tag);
}

export function storeThreadContext(
  threadId: string,
  context: Omit<ThreadContext, "threadId">
): void {
  const store = getStore();
  store.threads[threadId] = { threadId, ...context };
  if (context.messageId) {
    store.messageIndex[context.messageId] = threadId;
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

/** Return all known outbound Message-IDs for thread claim. */
export function getAllMessageIds(): string[] {
  const store = getStore();
  return Object.keys(store.messageIndex);
}
