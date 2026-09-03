import { lookupThread, signThread, storeThreadContext } from "./thread.js";

/** Outbound send over the worker REST API. Shared by every host adapter. */

export interface SendAttachment {
	name: string;
	content: string;
	contentType: string;
}

export interface SendParams {
	to: string;
	subject: string;
	body: string;
	html_body?: string;
	custom_headers?: Record<string, string>;
	footer_language?: "no" | "en";
	attachments?: SendAttachment[];
}

export interface SendContext {
	workerUrl: string;
	username: string;
	/** Short-lived access token from the WebSocket auth handshake. */
	accessToken: string | null;
}

export interface SendResult {
	success: boolean;
	messageId?: string;
	error?: string;
	/** "awaiting_approval" when the owner still has to approve the send. */
	status?: string;
	requestId?: string;
}

export async function sendViaRest(params: SendParams, ctx: SendContext): Promise<SendResult> {
	if (!ctx.accessToken) {
		return { success: false, error: "No access token. Wait for WebSocket authentication." };
	}

	try {
		const res = await fetch(`${ctx.workerUrl}/api/agents/${ctx.username}/send`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ctx.accessToken}`,
			},
			body: JSON.stringify(params),
		});
		return (await res.json()) as SendResult;
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : "REST send failed" };
	}
}

/**
 * Send a new email and record it as an outbound thread, returning the thread id the
 * agent uses to follow up. Thread ids are HMAC-signed locally so an inbound reply
 * cannot forge one.
 */
export async function sendNewEmail(
	params: Omit<SendParams, "custom_headers"> & { on_behalf_of?: string },
	ctx: SendContext & { fromAddress: string; hmacKey: Uint8Array },
): Promise<SendResult & { threadId: string }> {
	const nonce = crypto.randomUUID();
	const timestamp = new Date().toISOString();
	const threadId = signThread(ctx.hmacKey, {
		from: ctx.fromAddress,
		to: params.to,
		subject: params.subject,
		timestamp,
		nonce,
	});

	const custom_headers: Record<string, string> = {
		"X-Agentpost-Thread-Id": threadId,
		"X-Agentpost-Nonce": nonce,
	};
	if (params.on_behalf_of) custom_headers["X-Agentpost-On-Behalf-Of"] = params.on_behalf_of;

	const { on_behalf_of: _omit, ...rest } = params;
	const result = await sendViaRest({ ...rest, custom_headers }, ctx);

	if (result.success) {
		storeThreadContext(threadId, {
			to: params.to,
			subject: params.subject,
			body: params.body,
			timestamp,
			messageId: result.messageId,
			outbound: true,
		});
	}

	return { ...result, threadId };
}

/** Reply inside an existing thread, keeping In-Reply-To so the mail client threads it. */
export async function replyToThread(
	threadId: string,
	body: string,
	ctx: SendContext,
): Promise<SendResult & { to?: string; subject?: string }> {
	const thread = lookupThread(threadId);
	if (!thread) return { success: false, error: `Thread not found: ${threadId}` };

	const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;
	const result = await sendViaRest(
		{
			to: thread.to,
			subject,
			body,
			custom_headers: {
				"X-Agentpost-Thread-Id": threadId,
				...(thread.messageId ? { "In-Reply-To": thread.messageId } : {}),
			},
		},
		ctx,
	);

	if (result.success) {
		storeThreadContext(threadId, {
			to: thread.to,
			subject,
			body,
			timestamp: new Date().toISOString(),
			messageId: result.messageId,
			outbound: true,
		});
	}

	return { ...result, to: thread.to, subject };
}
