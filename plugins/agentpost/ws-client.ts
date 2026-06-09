import { fromBase64, sealedBoxDecrypt, toBase64 } from "./crypto.js";
import type { ClientToWorker, WorkerToClient } from "./protocol.js";
import { PROTOCOL_VERSION, TERMINAL_WS_CLOSE_CODES, WS_CLOSE } from "./protocol.js";
import type { KeyPair, WsClient, WsClientEvents } from "./types.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
/** Force-reconnect if a connection does not authenticate within this window. */
const CONNECT_TIMEOUT_MS = 20_000;

export function createWsClient(url: string, agentId: string, keys: KeyPair, events: WsClientEvents): WsClient {
	let ws: WebSocket | null = null;
	let backoff = INITIAL_BACKOFF_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let pongTimer: ReturnType<typeof setTimeout> | null = null;
	let connectTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	let accessToken: string | null = null;
	let awaitingPong = false;
	let needsUpgrade = false;
	let failedConnects = 0;
	// Every connect() bumps this. Socket event handlers capture their generation
	// and bail if a newer connect() has superseded them, so a late close/error
	// from an abandoned socket can never disturb the current connection.
	let generation = 0;

	function connect() {
		if (closed) return;
		cleanup();

		const myGen = ++generation;
		const wsUrl = `${url.replace(/^http/, "ws")}/agents/mail-agent/${agentId}?v=${PROTOCOL_VERSION}`;
		const socket = new WebSocket(wsUrl);
		ws = socket;

		// Watchdog: nothing guarantees `open` (or auth) ever fires - a reconnect
		// can wedge in CONNECTING after a network change or server restart, or open
		// but never complete auth. Without this the client would sit unauthenticated
		// forever. The ping watchdog only covers the post-auth window.
		clearConnectWatchdog();
		connectTimer = setTimeout(() => {
			if (myGen !== generation) return;
			console.error("[agentpost] Connection did not authenticate in time, reconnecting");
			try {
				socket.close();
			} catch {
				// Already closed
			}
			scheduleReconnect();
		}, CONNECT_TIMEOUT_MS);

		// NB: backoff is intentionally NOT reset on `open`. The server accepts the
		// WS upgrade (101) before its auth logic runs, so `open` fires even for
		// connections it is about to reject - resetting backoff there turns any
		// server-side rejection into a ~1s reconnect loop. Reset on auth success.
		socket.addEventListener("message", (event) => {
			if (myGen !== generation) return;
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

		socket.addEventListener("close", (event) => {
			if (myGen !== generation || closed) return;
			accessToken = null;
			stopPing();
			clearConnectWatchdog();
			events.onDisconnect();

			const code = (event as CloseEvent).code;
			if (code === WS_CLOSE.PROTOCOL_TOO_OLD) needsUpgrade = true;
			if (TERMINAL_WS_CLOSE_CODES.includes(code)) {
				// Reconnecting cannot fix this (outdated plugin, unregistered agent,
				// or bad keys). Stop looping; the user must update/re-register/restart.
				closed = true;
				console.error(
					`[agentpost] Connection rejected (code ${code}); not reconnecting. Update the plugin or re-register.`,
				);
				return;
			}
			if (code === WS_CLOSE.PENDING_VERIFICATION) {
				// Waiting on email verification - poll slowly instead of hammering.
				backoff = MAX_BACKOFF_MS;
			}
			// The edge rejects outdated clients before the WS upgrade (HTTP 426), so
			// a too-old client only ever sees a generic abnormal close. After a few
			// failures, ask the server whether we are simply too old to connect.
			failedConnects++;
			// Re-probe periodically, not just at exactly 3. A too-old client never
			// authenticates (so failedConnects never resets), and the /version probe can
			// itself fail transiently (machine offline, worker redeploying). A strict
			// `=== 3` check would then never fire again and the client would reconnect
			// forever without ever surfacing the upgrade notice.
			if (failedConnects >= 3 && failedConnects % 3 === 0) void checkUpgradeRequired();
			scheduleReconnect();
		});

		socket.addEventListener("error", (err) => {
			if (myGen !== generation) return;
			console.error("[agentpost] WebSocket error:", err);
			// Force close on this exact socket to trigger reconnect via close handler.
			try {
				socket.close();
			} catch {
				// Already closed
			}
		});
	}

	/** Ask the server for its minimum protocol version; flag upgrade if we are below it. */
	async function checkUpgradeRequired() {
		try {
			const res = await fetch(`${url.replace(/\/$/, "")}/version`);
			if (!res.ok) return;
			const { minProtocolVersion } = (await res.json()) as { minProtocolVersion?: number };
			if (typeof minProtocolVersion === "number" && PROTOCOL_VERSION < minProtocolVersion) {
				needsUpgrade = true;
				closed = true;
				cleanup();
				console.error(
					"[agentpost] PLEASE UPGRADE: this agentpost plugin is too old to connect. Update the plugin and restart.",
				);
			}
		} catch {
			// Network probe failed - leave reconnect loop running.
		}
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
					backoff = INITIAL_BACKOFF_MS;
					failedConnects = 0;
					clearConnectWatchdog();
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
			case "ping":
			case "pong":
				// Liveness only - the message listener already cleared the pong timer.
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
			// Send an app-level ping message; the server auto-responds with a pong.
			// (A raw ws.ping() frame is a no-op here - WHATWG/Bun WebSocket has no such
			// method - which is why idle connections used to die after the pong timeout.)
			send({ type: "ping" });
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

	function clearConnectWatchdog() {
		if (connectTimer) {
			clearTimeout(connectTimer);
			connectTimer = null;
		}
	}

	function cleanup() {
		stopPing();
		clearConnectWatchdog();
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

	function isUpgradeRequired(): boolean {
		return needsUpgrade;
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

	return { connect, close, send, getAccessToken, needsUpgrade: isUpgradeRequired };
}
