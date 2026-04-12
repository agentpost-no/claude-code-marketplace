export interface KeyPair {
	publicKey: Uint8Array;
	privateKey: Uint8Array;
}

export interface Config {
	workerUrl: string;
	agentId: string;
	email: string;
	username: string;
	status?: "pending" | "active";
	ownerEmail?: string;
}

export interface ParsedEmail {
	from: string;
	to: string;
	subject: string;
	date: string;
	messageId: string;
	inReplyTo?: string;
	references?: string;
	/** Primary body. If the email has an HTML part, this is the markdown conversion so link URLs are preserved. */
	textBody: string;
	htmlBody?: string;
	/** Extracted hyperlinks from the HTML body, in document order. */
	links: EmailLink[];
	attachments: ParsedAttachment[];
}

export interface EmailLink {
	text: string;
	href: string;
}

export interface ParsedAttachment {
	filename: string;
	mimeType: string;
	content: Uint8Array;
	size: number;
}

export interface AttachmentInfo {
	filename: string;
	savedPath: string;
	mimeType: string;
	size: number;
}

export interface ThreadContext {
	threadId: string;
	to: string;
	subject: string;
	body: string;
	/** Extracted hyperlinks from the inbound HTML body. Empty for outbound or text-only mail. */
	links?: EmailLink[];
	timestamp: string;
	messageId?: string;
	/** true for emails we sent, false/undefined for inbound */
	outbound?: boolean;
}

export interface ThreadSignInput {
	from: string;
	to: string;
	subject: string;
	timestamp: string;
	nonce: string;
}

export interface WsClientEvents {
	onAuthenticated: () => void;
	onEmail: (email: import("./protocol.js").EncryptedEmail) => void;
	onSendResult: (result: import("./protocol.js").SendEmailResult) => void;
	onDeliveryNotification: (notification: import("./protocol.js").DeliveryNotification) => void;
	onDrainStart: (count: number) => void;
	onDrainComplete: () => void;
	onDisconnect: () => void;
}

export interface WsClient {
	connect(): void;
	close(): void;
	send(msg: import("./protocol.js").ClientToWorker): void;
	getAccessToken(): string | null;
}
