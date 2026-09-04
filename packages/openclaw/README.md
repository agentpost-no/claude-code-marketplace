# @agentpost-no/openclaw

Email channel for [OpenClaw](https://openclaw.ai). Gives the agent its own address on
agentpost.no, delivers inbound mail as a direct-message conversation, and sends the
agent's replies back into the same email thread.

Two properties make this different from pointing OpenClaw at an IMAP mailbox:

- **Inbound mail is sealed to the agent's own key** (X25519 sealed box) before it is
  written to storage on the server. The operator cannot read it; only this plugin,
  holding the private key on your machine, can.
- **Outbound mail needs the owner's approval.** The worker holds each message until the
  owner approves it by email, unless that contact is already trusted. Outbound bodies are
  not encrypted - that is true of all email - so the approval step is the control.

## Install

```bash
openclaw plugins install npm:@agentpost-no/openclaw
```

Requires Node 22.22.3+, 24.15+, or 25.9+ (OpenClaw's own floor).

## Configure

```json5
{
  channels: {
    agentpost: {
      username: "claude",           // becomes claude@agentpost.no
      ownerEmail: "you@example.com", // gets the verification link, and status notices
      allowFrom: ["you@example.com", "colleague@example.com"],
    },
  },
}
```

Start the gateway. On first run the plugin registers the address and emails the owner a
verification link; the channel connects by itself once that link is clicked.

| Key | Meaning |
| --- | --- |
| `username` | Local part of the address. |
| `ownerEmail` | Owner. Receives verification, approval requests and status notices. |
| `displayName` | Name in the From field. Defaults to the capitalized username. |
| `allowFrom` | Senders allowed to reach the agent. |
| `dmPolicy` | `allowlist` (default) or `open`. |
| `home` | Storage root. Defaults to `<stateDir>/agentpost/<accountId>`. |
| `workerUrl` | Override the backend. Defaults to `https://api.agentpost.no`. |
| `accounts` | Named extra identities, same keys as above. |

Each account gets its own storage root, because the keypair *is* the identity.

## How mail flows

Inbound: worker pushes the sealed message over an authenticated WebSocket, the plugin
decrypts it locally, wraps it in `UNTRUSTED EXTERNAL CONTENT` markers, and dispatches it
as a DM from the sender's address. Attachments are written under `<home>/attachments/`.
The message is acknowledged only after it is durable locally, so a crash cannot lose mail.

Outbound: the agent's reply goes back through the worker into the same thread
(`In-Reply-To` preserved). A brand-new conversation takes its subject from the first line
of the message.

Delivery reports and approval results are logged, not dispatched as agent turns.

They used to arrive as a DM from `ownerEmail`, whose reply was emailed back to the owner.
Every such email produced its own delivery report, which produced another notice, which
produced another email - a self-feeding loop that sent twenty messages in seven minutes
before the server's rate limiter stopped it. Deduplicating notices cannot fix that shape,
because each delivery report carries the message id of a new email. A notice must not be
able to reach the network at all.

The client also refuses to send to the agent's own address, and caps itself at eight
sends per minute; the server's limiter protects the server, not your mailbox.

## Security notes

- Everything in an inbound email - sender, subject, body, filenames - is untrusted input.
  The markers say so explicitly; do not lift them.
- Thread context is only marked trusted when it is something the agent itself sent.
  `In-Reply-To` is attacker-controlled and never grants trust.
- Unknown senders are rejected by default (`dmPolicy: "allowlist"`).
- Keys live in `<home>/keys/` with `0600` permissions. They never leave the machine.

## Alternative: MCP only

If you want the tools but not a channel, the same client runs as a plain MCP server:

```bash
openclaw mcp add agentpost --command node \
  --arg /path/to/claude-channel-agentpost/dist/server.node.mjs
```

That gives `register_email`, `send_email`, `reply_to_email` and `check_inbox`. Inbound
mail is then pulled with `check_inbox` rather than pushed into a conversation.

## License

Apache-2.0
