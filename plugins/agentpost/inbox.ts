import { loadJsonFile, saveJsonFile } from "./file-store.js";
import { inboxPath } from "./paths.js";

/**
 * Durable local inbox.
 *
 * Inbound mail reaches Claude Code as a `notifications/claude/channel` push, which no
 * other MCP host understands. Every incoming item is therefore also written here, so a
 * host without channel support can pull the same content through the check_inbox tool.
 * Writing before the ack is what makes the ack safe: once an entry is on disk the server
 * may drop it from store-and-forward, whatever the host does with the notification.
 */

export type InboxKind = "email" | "delivery" | "send_result";

export interface InboxEntry {
	/** Dedupe key. Server message id where there is one, otherwise a generated id. */
	id: string;
	kind: InboxKind;
	/** ISO timestamp of when the item arrived. */
	receivedAt: string;
	meta: Record<string, string>;
	content: string;
	read: boolean;
}

interface InboxStore {
	entries: InboxEntry[];
}

const EMPTY_STORE: InboxStore = { entries: [] };

/** Hard cap on retained entries. Read entries are evicted before unread ones. */
const MAX_ENTRIES = 200;

let cache: InboxStore | null = null;

function getStore(): InboxStore {
	if (!cache) {
		cache = loadJsonFile<InboxStore>(inboxPath(), EMPTY_STORE);
	}
	return cache;
}

function persist(): void {
	if (cache) saveJsonFile(inboxPath(), cache);
}

function evict(entries: InboxEntry[]): InboxEntry[] {
	if (entries.length <= MAX_ENTRIES) return entries;
	const overflow = entries.length - MAX_ENTRIES;
	// Drop the oldest read entries first; only cut into unread mail if the whole
	// retained window is unread, in which case the oldest goes.
	const dropped = new Set<InboxEntry>();
	for (const entry of entries) {
		if (dropped.size >= overflow) break;
		if (entry.read) dropped.add(entry);
	}
	for (const entry of entries) {
		if (dropped.size >= overflow) break;
		dropped.add(entry);
	}
	return entries.filter((e) => !dropped.has(e));
}

/** Append an item, ignoring a repeat of an id already stored (server redelivery). */
export function appendInboxEntry(entry: Omit<InboxEntry, "read">): void {
	const store = getStore();
	if (store.entries.some((e) => e.id === entry.id)) return;
	store.entries.push({ ...entry, read: false });
	store.entries = evict(store.entries);
	persist();
}

export function unreadCount(): number {
	return getStore().entries.filter((e) => !e.read).length;
}

/** Return the oldest unread entries and mark them read. */
export function takeUnread(limit: number): { taken: InboxEntry[]; remaining: number } {
	const store = getStore();
	const unread = store.entries.filter((e) => !e.read);
	const taken = unread.slice(0, Math.max(1, limit));
	for (const entry of taken) {
		entry.read = true;
	}
	if (taken.length > 0) persist();
	return { taken, remaining: unread.length - taken.length };
}

/** Most recent entries regardless of read state, newest last. */
export function recentEntries(limit: number): InboxEntry[] {
	const entries = getStore().entries;
	return entries.slice(Math.max(0, entries.length - Math.max(1, limit)));
}
