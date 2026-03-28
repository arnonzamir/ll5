# Auth Token System

Signed, expiring tokens that embed user identity. PIN-based re-authentication every X days.

---

## Token Format

```
ll5.<base64url_payload>.<hex_signature>
```

**Payload** (JSON, base64url-encoded):
```json
{
  "uid": "f08f46b3-0a9c-41ae-9e6a-294c697424e4",
  "iat": 1711195200,
  "exp": 1711800000
}
```

**Signature**: `HMAC-SHA256(base64url_payload, AUTH_SECRET)` truncated to 32 hex chars.

**Validation** (in every MCP, no DB call):
1. Split on `.` → must have 3 parts, first must be `ll5`
2. Decode payload → JSON with `uid`, `iat`, `exp`
3. Verify `HMAC-SHA256(payload_part, AUTH_SECRET)` matches signature
4. Check `exp > now` → if not, return 401
5. Return `uid` as the authenticated user

## Auth Endpoint

Added to the gateway service:

```
POST /auth/token
Content-Type: application/json

{ "user_id": "<uuid>", "pin": "1234" }
```

Response:
```json
{
  "token": "ll5.eyJ1aW...",
  "user_id": "f08f46b3-...",
  "expires_at": "2026-04-04T00:00:00Z"
}
```

Errors:
- `401` — invalid PIN
- `404` — user not found

## Database

One table in the gateway's PG (or shared PG):

```sql
CREATE TABLE IF NOT EXISTS auth_users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE,
  pin_hash   TEXT NOT NULL,
  name       TEXT,
  token_ttl_days INTEGER NOT NULL DEFAULT 7,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

PIN stored as bcrypt hash.

## CLI Tool: ll5-auth

A small Node.js script installed globally or in the ll5-run workspace.

```
ll5-auth login                # prompt PIN, get token, save to ~/.ll5/token
ll5-auth status               # show user, expiry, days remaining
ll5-auth logout               # delete token
```

### login flow

```
$ ll5-auth login
User ID [f08f46b3-...]:      ← default from ~/.ll5/config or prompt
PIN: ****
Authenticating... done.
Token valid until 2026-04-04. Saved to ~/.ll5/token
```

### status flow

```
$ ll5-auth status
User: f08f46b3-0a9c-41ae-9e6a-294c697424e4
Expires: 2026-04-04T00:00:00Z (6 days remaining)
Status: valid
```

## Client Configuration

**`~/.ll5/token`** — contains the raw token string (one line)

**`~/.zshrc`** (or `.bashrc`):
```bash
export LL5_API_KEY=$(cat ~/.ll5/token 2>/dev/null)
```

**`.mcp.json`** (in project folder):
```json
{
  "mcpServers": {
    "personal-knowledge": {
      "type": "http",
      "url": "https://mcp-knowledge.noninoni.click/mcp",
      "headers": {
        "Authorization": "Bearer ${LL5_API_KEY}"
      }
    }
  }
}
```

## Claude Code SessionStart Hook

**`.claude/hooks/check-token.sh`**:
```bash
#!/bin/bash
TOKEN_FILE="$HOME/.ll5/token"
if [ ! -f "$TOKEN_FILE" ]; then
  echo "No LL5 token. Run: ll5-auth login" >&2
  exit 1
fi
TOKEN=$(cat "$TOKEN_FILE")
EXP=$(echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['exp'])" 2>/dev/null)
NOW=$(date +%s)
if [ -z "$EXP" ] || [ "$NOW" -gt "$EXP" ]; then
  echo "LL5 token expired. Run: ll5-auth login" >&2
  exit 1
fi
```

## MCP Auth Middleware

Replaces the current `API_KEY` + `USER_ID` env var pattern:

```typescript
import crypto from 'node:crypto';

interface TokenPayload {
  uid: string;
  iat: number;
  exp: number;
}

function validateToken(authHeader: string, authSecret: string): TokenPayload | null {
  if (!authHeader.startsWith('Bearer ll5.')) return null;
  const token = authHeader.slice(7); // remove "Bearer "
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'll5') return null;

  const [, payloadB64, signature] = parts;

  // Verify signature
  const expected = crypto.createHmac('sha256', authSecret)
    .update(payloadB64).digest('hex').slice(0, 32);
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
    return null;
  }

  // Decode and check expiry
  const payload: TokenPayload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString()
  );
  if (payload.exp < Date.now() / 1000) return null;

  return payload;
}
```

## Migration Path

1. Add `validateToken` to shared package
2. Update each MCP's auth middleware: try token auth first, fall back to legacy API_KEY for backwards compat
3. Add `/auth/token` endpoint to gateway
4. Create `auth_users` table
5. Build `ll5-auth` CLI
6. Add SessionStart hook to ll5-run
7. Once working, remove legacy API_KEY support

## Environment Variables

| Var | Where | Purpose |
|-----|-------|---------|
| `AUTH_SECRET` | All MCPs + gateway | Signs/validates tokens |
| `API_KEY` | All MCPs (legacy, removed later) | Backwards compat during migration |
| `USER_ID` | All MCPs (legacy, removed later) | Backwards compat during migration |
| `LL5_API_KEY` | User's shell | Token for Claude Code |
