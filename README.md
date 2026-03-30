# mailmcp - Email Channel for Claude Code

E2E-encrypted email channel. Receive forwarded emails (flight tickets, hotel bookings, etc.) and send email from a running Claude Code session. All encryption and decryption happens locally - the server never sees plaintext.

## Setup

```bash
/plugin marketplace add omelhus/claude-mailmcp-plugin
/plugin install mailmcp@omelhus
claude --channels plugin:mailmcp@omelhus
```

On first start, the plugin generates an X25519 keypair and registers with the backend to get an email address.

## Configuration

After installing, configure your preferences:

```bash
/mailmcp:configure worker_url https://mailmcp.omelhus.workers.dev
/mailmcp:configure username my-claude
```

Or set via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAILMCP_WORKER_URL` | `https://mailmcp.omelhus.workers.dev` | Backend worker URL |
| `MAILMCP_USERNAME` | `claude-{timestamp}` | Username for your email address |

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

All data under `~/.claude/channels/mailmcp/`:

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
- Single domain (mail.mcp.run) currently
- HMAC reply verification server-side is pending

## License

Apache-2.0
