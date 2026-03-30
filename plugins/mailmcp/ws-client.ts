import { sealedBoxDecrypt, fromBase64, toBase64 } from "./crypto.js";
import type { KeyPair, WsClientEvents, WsClient } from "./types.js";
import type { WorkerToClient, ClientToWorker } from "./protocol.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export function createWsClient(url: string, agentId: string, keys: KeyPair, events: WsClientEvents): WsClient {
	let ws: WebSocket | null = null;
	let backoff = INITIAL_BACKOFF_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	function connect() {
		if (closed) return;

		const wsUrl = `${url.replace(/^http/, "ws")}/agents/mail-agent/${agentId}`;
		ws = new WebSocket(wsUrl);

		ws.addEventListener("open", () => {
			backoff = INITIAL_BACKOFF_MS;
		});

		ws.addEventListener("message", (event) => {
			try {
				const msg = JSON.parse(
					typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer),
				) as WorkerToClient;
				handleMessage(msg);
			} catch (err) {
				console.error("[mailmcp] Failed to parse WebSocket message:", err);
			}
		});

		ws.addEventListener("close", () => {
			if (closed) return;
			events.onDisconnect();
			scheduleReconnect();
		});

		ws.addEventListener("error", (err) => {
			console.error("[mailmcp] WebSocket error:", err);
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
					events.onAuthenticated();
				} else {
					console.error("[mailmcp] Auth failed:", msg.error);
				}
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

	function scheduleReconnect() {
		if (closed || reconnectTimer) return;
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

	function close() {
		closed = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (ws) {
			ws.close();
			ws = null;
		}
	}

	return { connect, close, send };
}
