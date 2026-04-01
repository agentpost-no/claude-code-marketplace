# Agentpost - Email Channel for Claude Code

E2E-encrypted email channel. Receive forwarded emails (flight tickets, hotel bookings, etc.) and send email from a running Claude Code session. All encryption and decryption happens locally - the server never sees plaintext.

## Setup

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

## Tools

| Tool | Description |
|------|-------------|
| `send_email` | Send a new email (to, subject, body) |
| `reply_to_email` | Reply in an existing thread (thread_id, body) |

## How It Works

1. Emails sent to your address arrive at a Cloudflare Worker
2. The worker encrypts the email with your X25519 public key (sealed box)
3. Encrypted email is delivered to your local client via WebSocket
4. The client decrypts locally and presents it to Claude with prompt injection protection
5. Claude can reply using the tools above

## Security

- **E2E encrypted**: Sealed box (X25519 + XSalsa20-Poly1305). Server stores only ciphertext.
- **Challenge-response auth**: WebSocket connections verified via encrypted challenge.
- **Thread integrity**: Outbound emails signed with local HMAC key.
- **Prompt injection defense**: All email content wrapped in UNTRUSTED markers. Only locally-stored thread context is trusted.
- **Key protection**: Private keys stored with mode 0o600.

## Local Storage

All data under `~/.claude/channels/agentpost/`:

| Path | Purpose |
|------|---------|
| `keys/private.key` | X25519 private key (0o600) |
| `keys/public.key` | X25519 public key |
| `keys/hmac.key` | Thread signing key (0o600) |
| `config.json` | Worker URL, email, agent ID |
| `threads.json` | Thread context for reply tracking |
| `attachments/` | Saved email attachments |

## Limitations

- No forward secrecy: key compromise exposes historical emails
- Single domain (agentpost.no) currently
- HMAC reply verification server-side is pending

## License

Apache-2.0
