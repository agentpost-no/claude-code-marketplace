import { fromBase64, sealedBoxDecrypt, toBase64 } from "./crypto.js";
import type { ClientToWorker, WorkerToClient } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { KeyPair, WsClient, WsClientEvents } from "./types.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

export function createWsClient(url: string, agentId: string, keys: KeyPair, events: WsClientEvents): WsClient {
	let ws: WebSocket | null = null;
	let backoff = INITIAL_BACKOFF_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let pongTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	let accessToken: string | null = null;
	let awaitingPong = false;

	function connect() {
		if (closed) return;
		cleanup();

		const wsUrl = `${url.replace(/^http/, "ws")}/agents/mail-agent/${agentId}?v=${PROTOCOL_VERSION}`;
		ws = new WebSocket(wsUrl);

		ws.addEventListener("open", () => {
			backoff = INITIAL_BACKOFF_MS;
		});

		ws.addEventListener("message", (event) => {
			// Any message counts as a pong
			awaitingPong = false;
			clearPongTimeout();

			try {
				const msg = JSON.parse(
					typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer),
				) as WorkerToClient;
				handleMessage(msg);
			} catch (err) {
				console.error("[agentpost] Failed to parse WebSocket message:", err);
			}
		});

		ws.addEventListener("close", () => {
			if (closed) return;
			accessToken = null;
			stopPing();
			events.onDisconnect();
			scheduleReconnect();
		});

		ws.addEventListener("error", (err) => {
			console.error("[agentpost] WebSocket error:", err);
			// Force close to trigger reconnect via close handler
			try {
				ws?.close();
			} catch {
				// Already closed
			}
		});
	}

	function handleMessage(msg: WorkerToClient) {
		switch (msg.type) {
			case "auth_challenge": {
				const ciphertext = fromBase64(msg.encryptedChallenge);
				const decrypted = sealedBoxDecrypt(ciphertext, keys.publicKey, keys.privateKey);
				send({
					type: "auth_response",
					challenge: toBase64(decrypted),
				});
				break;
			}
			case "auth_result":
				if (msg.success) {
					accessToken = msg.accessToken ?? null;
					startPing();
					events.onAuthenticated();
				} else {
					console.error("[agentpost] Auth failed:", msg.error);
				}
				break;
			case "token_refresh":
				accessToken = msg.accessToken;
				break;
			case "encrypted_email":
				events.onEmail(msg);
				break;
			case "send_email_result":
				events.onSendResult(msg);
				break;
			case "delivery_notification":
				events.onDeliveryNotification(msg);
				break;
			case "store_drain":
				events.onDrainStart(msg.count);
				break;
			case "store_drain_complete":
				events.onDrainComplete();
				break;
		}
	}

	function startPing() {
		stopPing();
		pingTimer = setInterval(() => {
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			if (awaitingPong) {
				// Previous ping never got a response - connection is dead
				console.error("[agentpost] Ping timeout, reconnecting");
				try {
					ws.close();
				} catch {
					// Force reconnect
				}
				return;
			}
			awaitingPong = true;
			// Send a ping frame. If the server doesn't support ping/pong,
			// any server message within the timeout window also clears awaitingPong.
			try {
				ws.ping?.();
			} catch {
				// ping() not available in all runtimes, rely on message-based detection
			}
			pongTimer = setTimeout(() => {
				if (awaitingPong) {
					console.error("[agentpost] Pong timeout, reconnecting");
					try {
						ws?.close();
					} catch {
						// Force reconnect
					}
				}
			}, PONG_TIMEOUT_MS);
		}, PING_INTERVAL_MS);
	}

	function stopPing() {
		if (pingTimer) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		clearPongTimeout();
		awaitingPong = false;
	}

	function clearPongTimeout() {
		if (pongTimer) {
			clearTimeout(pongTimer);
			pongTimer = null;
		}
	}

	function cleanup() {
		stopPing();
		if (ws) {
			try {
				ws.close();
			} catch {
				// Already closed
			}
			ws = null;
		}
	}

	function scheduleReconnect() {
		if (closed || reconnectTimer) return;
		console.error(`[agentpost] Reconnecting in ${Math.round(backoff / 1000)}s`);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, backoff);
		backoff = Math.min(backoff * 2 + Math.random() * 1000, MAX_BACKOFF_MS);
	}

	function send(msg: ClientToWorker) {
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	function getAccessToken(): string | null {
		return accessToken;
	}

	function close() {
		closed = true;
		accessToken = null;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		cleanup();
	}

	return { connect, close, send, getAccessToken };
}
