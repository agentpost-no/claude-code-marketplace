import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { Type } from "typebox";
import { getRuntime } from "./registry.js";

/**
 * Email-shaped tools, alongside the channel.
 *
 * These deliberately cannot read from disk. The Claude Code plugin accepts file paths
 * because there the harness already governs the agent's filesystem access; in OpenClaw
 * the host owns that policy and hands it over as `mediaReadFile`, which only the channel
 * path holds. A tool that read any path the agent named would route around it - and the
 * text that names the path can arrive in an untrusted email.
 *
 * A channel message is a message: text, a recipient, a thread. Email is not that - it
 * has a subject line, attachments, an HTML alternative, and a sender the recipient
 * reads before anything else. The Claude Code plugin exposes those as tool parameters,
 * and an agent in OpenClaw should be able to write the same email.
 *
 * Inbound mail surfaces wherever the owner already talks to the agent. Replying is
 * agentpost_reply, not a message in that session: what the agent says there is meant
 * for the owner, not for whoever sent the email.
 */
export function registerTools(api: OpenClawPluginApi): void {
	api.registerTool({
		name: "agentpost_send_email",
		label: "Send email",
		description:
			"Send a real email through agentpost, with a subject line and attachments. Use this instead of a plain channel message when the subject matters, when the recipient is outside an existing conversation, or when the message needs an HTML alternative. The owner approves outbound mail unless the recipient is already a trusted contact - a queued message has not been sent yet, so do not tell anyone to check their inbox until approval is confirmed.",
		parameters: Type.Object({
			to: Type.String({ description: "Recipient email address." }),
			subject: Type.String({ description: "Subject line. Supports full UTF-8." }),
			body: Type.String({ description: "Plain text body. Supports full UTF-8." }),
			html_body: Type.Optional(
				Type.String({ description: "HTML body. When given, the plain text body is the fallback." }),
			),
			on_behalf_of: Type.Optional(
				Type.String({ description: "Person this is sent for. Shows as 'Agent on behalf of Name' in From." }),
			),
			footer_language: Type.Optional(
				Type.Union([Type.Literal("no"), Type.Literal("en")], {
					description: "Language for the footer. Defaults to 'en'.",
				}),
			),
			attachments: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Filename the recipient sees, e.g. 'report.pdf'." }),
						content: Type.String({ description: "File content, base64." }),
						contentType: Type.String({ description: "MIME type, e.g. 'application/pdf'." }),
					}),
					{
						description:
							"Attachments, base64. To attach a file from disk, send it through the channel instead: the host reads it under its own sandbox roots, which this tool cannot do.",
					},
				),
			),
			account: Type.Optional(Type.String({ description: "Account id, when more than one is configured." })),
		}),
		outputSchema: Type.Object({
			status: Type.String(),
			threadId: Type.Optional(Type.String()),
			messageId: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const { to, subject, body, html_body, on_behalf_of, footer_language, attachments, account } = params as {
				to: string;
				subject: string;
				body: string;
				html_body?: string;
				on_behalf_of?: string;
				footer_language?: "no" | "en";
				attachments?: Array<{ name: string; content: string; contentType: string }>;
				account?: string;
			};

			const runtime = getRuntime(account);
			if (!runtime) {
				return {
					content: [{ type: "text", text: "agentpost is not connected." }],
					details: { status: "not-connected" },
					isError: true,
				};
			}

			const result = await runtime.sendEmail({
				to,
				subject,
				body,
				html_body,
				on_behalf_of,
				footer_language,
				attachments,
			});
			if (!result.success) {
				return {
					content: [{ type: "text", text: `Send failed: ${result.error}` }],
					details: { status: "failed" },
					isError: true,
				};
			}

			const queued = result.status === "awaiting_approval";
			const details = {
				status: result.status ?? "sent",
				threadId: result.threadId,
				messageId: result.messageId,
			};
			return {
				content: [
					{
						type: "text",
						text: queued
							? `Queued for the owner's approval. It has NOT been sent yet; you will be told when it is approved or rejected. Thread: ${result.threadId}`
							: `Sent to ${to}. Thread: ${result.threadId}`,
					},
				],
				details,
			};
		},
	});

	api.registerTool({
		name: "agentpost_reply",
		label: "Reply to email",
		description:
			"Reply inside an existing email thread, keeping its subject and threading. Use the thread id from the message you are answering. Inbound mail arrives as a notification, not as a thread you can answer by talking - replying is this call. The owner approves outbound mail unless the recipient is a trusted contact.",
		parameters: Type.Object({
			thread_id: Type.String({ description: "Thread id from the inbound message you are replying to." }),
			body: Type.String({ description: "Reply body, plain text. Supports full UTF-8." }),
			account: Type.Optional(Type.String({ description: "Account id, when more than one is configured." })),
		}),
		outputSchema: Type.Object({ status: Type.String(), to: Type.Optional(Type.String()) }),
		async execute(_id, params) {
			const { thread_id, body, account } = params as { thread_id: string; body: string; account?: string };
			const runtime = getRuntime(account);
			if (!runtime) {
				return {
					content: [{ type: "text", text: "agentpost is not connected." }],
					details: { status: "not-connected" },
					isError: true,
				};
			}

			const result = await runtime.reply({ threadId: thread_id, body });
			if (!result.success) {
				return {
					content: [{ type: "text", text: `Reply failed: ${result.error}` }],
					details: { status: "failed" },
					isError: true,
				};
			}

			const queued = result.status === "awaiting_approval";
			return {
				content: [
					{
						type: "text",
						text: queued
							? `Reply to ${result.to} is queued for the owner's approval. It has NOT been sent yet.`
							: `Replied to ${result.to}.`,
					},
				],
				details: { status: result.status ?? "sent", to: result.to },
			};
		},
	});

	api.registerTool({
		name: "agentpost_check_inbox",
		label: "Check inbox",
		description:
			"Read inbound email, delivery reports and approval results that have not been read yet. Mail normally arrives on its own as a conversation, so reach for this when the gateway was down, or when you suspect you missed something.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Maximum items to return. Defaults to 10, oldest first." })),
			account: Type.Optional(Type.String({ description: "Account id, when more than one is configured." })),
		}),
		outputSchema: Type.Object({ count: Type.Number(), remaining: Type.Number() }),
		async execute(_id, params) {
			const { limit, account } = params as { limit?: number; account?: string };
			const runtime = getRuntime(account);
			if (!runtime) {
				return {
					content: [{ type: "text", text: "agentpost is not connected." }],
					details: { count: 0, remaining: 0 },
					isError: true,
				};
			}

			const { taken, remaining } = runtime.readInbox(limit ?? 10);
			if (taken.length === 0) {
				return { content: [{ type: "text", text: "No unread mail." }], details: { count: 0, remaining: 0 } };
			}

			const blocks = taken.map((entry) => {
				const header = `[${entry.kind}] ${entry.receivedAt}${
					entry.meta.reply_thread_id ? ` (thread: ${entry.meta.reply_thread_id})` : ""
				}`;
				return `${header}\n${entry.content}`;
			});
			if (remaining > 0) blocks.push(`${remaining} more unread. Call again to read them.`);

			return { content: [{ type: "text", text: blocks.join("\n\n") }], details: { count: taken.length, remaining } };
		},
	});
}
