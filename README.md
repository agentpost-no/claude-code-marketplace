# Agentpost - Email Channel for AI Agents

Email channel for AI agents. Receive and send email from a running agent session. Inbound mail is encrypted to the agent's own key, outbound needs owner approval, attachments supported.

Three ways to run it:

| Host | Package | Inbound mail |
|------|---------|--------------|
| Claude Code | `plugins/agentpost` (this marketplace) | Pushed as a channel notification |
| OpenClaw | [`packages/openclaw-agentpost`](packages/openclaw-agentpost) | Pushed as a DM conversation |
| Any MCP host | `plugins/agentpost` over stdio | Pulled with `check_inbox` |

## Setup (Claude Code)

```bash
/plugin marketplace add agentpost-no/claude-code-marketplace
/plugin install agentpost@agentpost-no
claude --dangerously-load-development-channels plugin:agentpost@agentpost-no
```

On first start, the plugin generates an X25519 keypair. Use the `register_email` tool to register a username and get an email address.

## Registration

After installing, use the `register_email` tool to pick your email address:

```
register_email(username: "my-claude", owner_email: "you@example.com")
```

This registers `my-claude@agentpost.no` and sends a verification link to the owner email. Click the link, then call `register_email` again to activate.

| Environment Variable | Default | Description |
|----------|---------|-------------|
| `AGENTPOST_WORKER_URL` | `https://api.agentpost.no` | Backend worker URL |
| `AGENTPOST_HOME` | `~/.claude/channels/agentpost` | Storage root for keys, threads and inbox |

## Tools

| Tool | Description |
|------|-------------|
| `register_email` | Register the address (username, owner_email) |
| `send_email` | Send a new email (to, subject, body, attachments) |
| `reply_to_email` | Reply in an existing thread (thread_id, body) |
| `check_inbox` | Read unread mail, delivery reports and approval results |

## Other hosts

**OpenClaw** has a native channel plugin - see
[packages/openclaw-agentpost](packages/openclaw-agentpost).

**Any MCP host** can run the same client over stdio. Build once (`bun run build` in
`plugins/agentpost`), then point the host at the Node bundle:

```bash
openclaw mcp add agentpost --command node --arg /path/to/plugins/agentpost/dist/server.node.mjs
```

Hosts that do not implement the Claude channel notification pull inbound mail with
`check_inbox`, which returns the full message content. Set `AGENTPOST_HOME` to keep that
host's keys and threads out of `~/.claude`.

## How It Works

1. Emails sent to your address arrive at a Cloudflare Worker
2. The worker encrypts the email with your X25519 public key (sealed box)
3. Encrypted email is delivered to your local client via WebSocket
4. The client decrypts locally and presents it to the agent with prompt injection protection
5. The agent replies; the worker holds the message for owner approval unless the contact is trusted

## Security

- **Encrypted storage**: Sealed box (X25519 + XSalsa20-Poly1305). Server stores only ciphertext in R2.
- **Challenge-response auth**: WebSocket connections verified via encrypted challenge.
- **Thread integrity**: Outbound emails signed with local HMAC key.
- **Prompt injection defense**: All email content wrapped in UNTRUSTED markers. Only locally-stored thread context is trusted.
- **Key protection**: Private keys stored with mode 0o600.

## Local Storage

All data under `~/.claude/channels/agentpost/` (or `AGENTPOST_HOME`):

| Path | Purpose |
|------|---------|
| `keys/private.key` | X25519 private key (0o600) |
| `keys/public.key` | X25519 public key |
| `keys/hmac.key` | Thread signing key (0o600) |
| `config.json` | Worker URL, email, agent ID |
| `threads.json` | Thread context for reply tracking |
| `inbox.json` | Unread mail and notices, so nothing is lost between sessions |
| `attachments/` | Saved email attachments |

## Limitations

- No forward secrecy: key compromise exposes historical emails
- Single domain (agentpost.no) currently
- HMAC reply verification server-side is pending

## License

Apache-2.0
