# client

MCP channel client for Claude Code. Runs locally as a subprocess over stdio.

## Stack

Bun, @modelcontextprotocol/sdk, libsodium-wrappers-sumo, postal-mime.

## Files

- `server.ts` - Entry point. MCP server with claude/channel capability. Tools: send_email, reply_to_email. Startup: keygen, register, connect WS, stdio.
- `crypto.ts` - Key management (X25519 keypair, HMAC key). Sealed box decryption. Base64 helpers (toBase64/fromBase64).
- `ws-client.ts` - WebSocket client. Auth challenge-response, exponential backoff with jitter (1s-30s), message dispatch.
- `thread.ts` - HMAC thread signing. In-memory cache backed by threads.json. Lookup by message ID or thread ID only. getAllMessageIds returns outbound-only IDs for thread claim.
- `email-parser.ts` - MIME parsing via postal-mime. UNTRUSTED EXTERNAL CONTENT formatting. Attachment saving with filename sanitization.
- `store.ts` - Config load/save. Worker registration via HTTP.
- `paths.ts` - All storage paths: KEYS_DIR, ATTACHMENTS_DIR, CONFIG_PATH, THREADS_PATH.
- `file-store.ts` - Generic JSON file load/save with safe permissions.
- `types.ts` - KeyPair, Config, ParsedEmail, ThreadContext, WsClient, etc.
- `protocol.ts` - Wire protocol types. Keep in sync with shared/protocol.ts.

## Conventions

- Base64: always use `toBase64`/`fromBase64` from crypto.ts. Never call sodium.to_base64 directly.
- Paths: import from paths.ts. Never construct base path inline.
- JSON files: use loadJsonFile/saveJsonFile from file-store.ts.
- Tool responses: use toolError/toolOk helpers in server.ts.
- All email content is UNTRUSTED. From, subject, body, filenames - all inside UNTRUSTED block.
- Thread context from local store only. Subject-line fallback removed.
- ThreadContext.outbound flag: true for sent emails, false/omitted for inbound. Only outbound IDs claimed on reconnect.
- Startup polls /api/status/:agent when config is pending, auto-activates if owner verified.

## Storage

All under `~/.claude/channels/agentpost/`:
- `keys/` (0o700): public.key, private.key (0o600), hmac.key (0o600)
- `config.json`: workerUrl, agentId, email, username
- `threads.json`: thread contexts + message ID index
- `attachments/{date}/`: saved attachments

## Env Vars

- `AGENTPOST_WORKER_URL` - defaults to https://api.agentpost.no
- `AGENTPOST_USERNAME` - defaults to claude-{timestamp}
