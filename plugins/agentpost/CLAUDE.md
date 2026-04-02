# client (agentpost plugin)

Claude Code plugin for agentpost.no. Runs locally as MCP server over stdio.

## Stack

Bun, @modelcontextprotocol/sdk, libsodium-wrappers-sumo, postal-mime.

## Files

- `server.ts` - MCP server. Tools: register_email, send_email (with file_paths), reply_to_email.
- `crypto.ts` - Key management (X25519 keypair, HMAC). Sealed box decryption. Base64 helpers.
- `ws-client.ts` - WebSocket client. Auth challenge-response, access token management, exponential backoff.
- `thread.ts` - HMAC thread signing. In-memory cache backed by threads.json.
- `email-parser.ts` - MIME parsing. UNTRUSTED EXTERNAL CONTENT formatting. Attachment saving.
- `store.ts` - Config load/save. Worker registration via HTTP.
- `paths.ts` - All storage paths under ~/.claude/channels/agentpost/.
- `file-store.ts` - Generic JSON file load/save with safe permissions.
- `types.ts` - KeyPair, Config, WsClient (with getAccessToken), etc.
- `protocol.ts` - Wire protocol (keep in sync with worker/src/protocol.ts).

## Auth Flow

1. WS connect with `?v=PROTOCOL_VERSION`
2. Server sends encrypted challenge (sealed box with client public key)
3. Client decrypts and responds
4. Server verifies, returns access token (HMAC, 15 min) in auth_result
5. Client uses Bearer token for REST send calls
6. Server pushes token_refresh via WS before expiry

## Sending

- REST POST to `/api/agents/:name/send` with Bearer token
- JSON for text-only, multipart FormData for file attachments
- `file_paths` parameter: reads local files, auto-detects MIME type
- `attachments` parameter: base64 blobs for programmatic content

## Storage

All under `~/.claude/channels/agentpost/`:
- `keys/` (0o700): public.key, private.key, hmac.key (0o600)
- `config.json`: workerUrl, agentId, email, username, status
- `threads.json`: thread contexts + message ID index
- `attachments/{date}/`: saved inbound attachments
