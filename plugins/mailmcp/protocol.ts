/**
 * Wire protocol types shared between worker and client.
 * Copy this file to both worker/src/ and client/ when updating.
 */

// --- Authentication ---

export interface AuthChallenge {
  type: "auth_challenge";
  /** Sealed box encrypted challenge (base64) */
  encryptedChallenge: string;
}

export interface AuthResponse {
  type: "auth_response";
  /** Decrypted challenge bytes (base64) */
  challenge: string;
}

export interface AuthResult {
  type: "auth_result";
  success: boolean;
  error?: string;
}

// --- Email Messages ---

export interface EncryptedEmail {
  type: "encrypted_email";
  /** Unique message ID assigned by the worker */
  id: string;
  /** Sender address (plaintext metadata - not sensitive) */
  from: string;
  /** Recipient address */
  to: string;
  /** Timestamp of receipt (ISO 8601) */
  receivedAt: string;
  /** Size of the encrypted payload in bytes */
  size: number;
  /** Whether this is a verified reply to an outbound email (via Cloudflare HMAC) */
  isVerifiedReply: boolean;
  /** Sealed box encrypted raw MIME content (base64) */
  encryptedContent: string;
  /** Original Message-ID from the inbound email (for threading replies) */
  emailMessageId?: string;
  /** In-Reply-To header from the inbound email */
  inReplyTo?: string;
}

export interface EmailAck {
  type: "email_ack";
  /** Message ID being acknowledged */
  id: string;
}

// --- Sending ---

export interface SendEmailRequest {
  type: "send_email";
  /** Client-generated request ID for correlation */
  requestId: string;
  /** Recipient address */
  to: string;
  /** Email subject */
  subject: string;
  /** Plain text body */
  body: string;
  /** Optional HTML body (sent alongside text as multipart) */
  htmlBody?: string;
  /** Optional custom headers (e.g., thread tracking) */
  customHeaders?: Record<string, string>;
}

export interface SendEmailResult {
  type: "send_email_result";
  /** Echoed request ID */
  requestId: string;
  success: boolean;
  /** Message-ID header assigned by the mail system */
  messageId?: string;
  error?: string;
}

// --- Store and Forward ---

export interface StoreDrain {
  type: "store_drain";
  /** Number of stored messages about to be sent */
  count: number;
}

export interface StoreDrainComplete {
  type: "store_drain_complete";
}

// --- Registration ---

export interface RegisterRequest {
  username: string;
  /** X25519 public key (base64) */
  publicKey: string;
  /** Display name for outbound email (defaults to capitalized username) */
  displayName?: string;
  /** Owner's email for verification */
  ownerEmail: string;
}

export interface RegisterResponse {
  email: string;
  agentId: string;
  status: "pending" | "active";
  message?: string;
}

// --- Thread Ownership ---

export interface ClaimThreads {
  type: "claim_threads";
  /** Message-IDs of outbound emails this client owns */
  messageIds: string[];
}

// --- Delivery Notifications ---

export interface DeliveryNotification {
  type: "delivery_notification";
  /** Original Message-ID this notification is about */
  messageId: string;
  /** Event type */
  event: "delivered" | "bounced" | "spam_complaint" | "opened";
  /** Human-readable description */
  description: string;
  /** Recipient address */
  recipient: string;
  /** ISO timestamp of the event */
  timestamp: string;
}

// --- Union types for WebSocket messages ---

export type WorkerToClient =
  | AuthChallenge
  | AuthResult
  | EncryptedEmail
  | StoreDrain
  | StoreDrainComplete
  | SendEmailResult
  | DeliveryNotification;

export type ClientToWorker =
  | AuthResponse
  | EmailAck
  | SendEmailRequest
  | ClaimThreads;
