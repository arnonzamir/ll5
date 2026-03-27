# Authentication and Multi-Tenancy

How users are identified, authenticated, and isolated across the system.

## User Model

- Users are identified by a UUID (`user_id`).
- For now (single user): `user_id` is a fixed UUID configured via environment variable.
- For multi-user: auth service with registration, login, and JWT issuance.

```
# Single-user configuration
USER_ID=550e8400-e29b-41d4-a716-446655440000
```

## Architecture Overview

There are three authentication boundaries in the system:

1. **Phone to Gateway** -- webhook tokens in URL path.
2. **Claude Code to MCPs** -- API keys (v1) or JWTs (v2) in HTTP headers.
3. **User to Claude Code** -- handled by Claude Code itself (out of scope for this design).

```
Phone                    Claude Code                Auth Service (v2)
  |                          |                            |
  |--POST /webhook/:token--->|                            |
  |                      Gateway                          |
  |                          |                            |
  |                     MCP (HTTP+SSE)                    |
  |                      +--------+                       |
  |                      | API key| (v1)                  |
  |                      |  or    |                       |
  |                      |  JWT   | (v2)                  |
  |                      +--------+                       |
```

## V1: API Key Authentication

Recommended for the initial single-user deployment and early multi-user.

### How It Works

1. Each user is assigned a single API key (a random 256-bit string, hex-encoded).
2. Claude Code includes the key in every MCP request via HTTP header: `Authorization: Bearer <api_key>`.
3. Each MCP validates the key and resolves it to a `user_id`.
4. All subsequent operations are scoped to that `user_id`.

### Key Storage

For single user, the API key is an environment variable on each MCP:

```
API_KEY=a1b2c3d4e5f6...
USER_ID=550e8400-e29b-41d4-a716-446655440000
```

For multi-user, keys are stored in a shared PostgreSQL table:

```sql
CREATE TABLE api_keys (
    key_hash    TEXT PRIMARY KEY,   -- SHA-256 hash of the key
    user_id     UUID NOT NULL,
    label       TEXT,               -- e.g. "claude-code-laptop"
    created_at  TIMESTAMPTZ DEFAULT now(),
    revoked_at  TIMESTAMPTZ
);
```

Keys are hashed before storage. The MCP receives the raw key, hashes it, and looks up the hash.

### Auth Flow (V1)

```
Claude Code                        MCP Server
    |                                  |
    |-- HTTP request ----------------->|
    |   Authorization: Bearer <key>    |
    |                                  |
    |                          hash(key)
    |                          lookup in config or DB
    |                          resolve user_id
    |                                  |
    |                          if invalid:
    |<-- 401 Unauthorized -------------|
    |                                  |
    |                          if valid:
    |                          set request.user_id
    |                          proceed with operation
    |<-- 200 OK + response ------------|
```

### Pros and Cons

**Pros:** Simple. No token expiry to manage. Easy to debug. No auth service dependency.

**Cons:** Keys don't expire (must be manually revoked). No fine-grained permissions. Key must be distributed to every MCP.

## V2: JWT Authentication

Recommended for multi-user deployment with registration and onboarding.

### How It Works

1. User authenticates with the auth service (login endpoint).
2. Auth service issues a JWT with `user_id` in claims.
3. Claude Code includes the JWT in every MCP request: `Authorization: Bearer <jwt>`.
4. Each MCP validates the JWT signature and extracts `user_id` from claims.
5. No database lookup needed per request -- validation is cryptographic.

### Auth Service

A small standalone service responsible for:

- User registration and login.
- JWT issuance (access token + refresh token).
- Token refresh.
- User profile management.

```sql
CREATE TABLE users (
    user_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,        -- bcrypt hash
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE refresh_tokens (
    token_hash  TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(user_id),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ
);
```

### JWT Claims

```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",
  "email": "arnon@example.com",
  "iat": 1711526400,
  "exp": 1711530000
}
```

- `sub`: the `user_id`.
- Access tokens expire in 1 hour.
- Refresh tokens expire in 30 days.

### Auth Flow (V2)

```
Claude Code              Auth Service               MCP Server
    |                        |                          |
    |-- POST /login -------->|                          |
    |   { email, password }  |                          |
    |                        |                          |
    |<-- { access_token,  ---|                          |
    |      refresh_token }   |                          |
    |                        |                          |
    |-- HTTP request --------|------------------------->|
    |   Authorization:       |                          |
    |   Bearer <jwt>         |                          |
    |                        |                   verify signature
    |                        |                   check expiry
    |                        |                   extract user_id
    |                        |                          |
    |<-- 200 OK + response --|--------------------------|
    |                        |                          |
    | (when access token expires)                       |
    |-- POST /refresh ------>|                          |
    |   { refresh_token }    |                          |
    |<-- { access_token } ---|                          |
```

### JWT Signing

- **V2 initial:** symmetric signing (HS256) with a shared secret distributed to all MCPs.
- **V2 mature:** asymmetric signing (RS256). Auth service holds the private key. MCPs hold the public key. No shared secret to compromise.

### Pros and Cons

**Pros:** Tokens expire automatically. No per-request DB lookup. Standard, well-understood. Can add scopes/permissions to claims later.

**Cons:** More infrastructure (auth service). Token refresh logic needed. JWT revocation requires a deny-list or short expiry.

## MCP Protocol Auth

The MCP specification includes an authentication mechanism. If the protocol supports passing auth tokens natively (rather than via HTTP headers), prefer that to maintain protocol compliance. The token content (API key or JWT) remains the same -- only the transport changes.

Investigate the current MCP auth spec before implementation. If it provides a standard auth handshake, use it. If not, fall back to HTTP `Authorization` header.

## Gateway Authentication

The gateway uses a separate authentication mechanism: webhook tokens in the URL path.

```
POST https://gateway.example.com/webhook/abc123def456
```

- Token is in the URL, not a header (simpler for phone automation tools like Tasker).
- Token maps to `user_id` the same way as API keys.
- Gateway tokens are independent from MCP API keys -- a user has both.
- See the [Gateway design doc](gateway.md) for token storage details.

## Data Isolation

Every data store enforces user-level isolation.

### Elasticsearch

- Every document includes a `user_id` field.
- Every query includes a `term` filter on `user_id`.
- Index templates enforce `user_id` as a required field.

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "user_id": "550e8400-..." } },
        { "range": { "timestamp": { "gte": "now-7d" } } }
      ]
    }
  }
}
```

### PostgreSQL

- Every table includes a `user_id UUID NOT NULL` column.
- Every query includes `WHERE user_id = $1`.
- Defense-in-depth: Row Level Security policies as a second layer.

```sql
-- RLS policy (defense-in-depth)
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_isolation ON actions
    USING (user_id = current_setting('app.current_user_id')::uuid);
```

### No Shared Data

There is no concept of shared or public data between users. Every piece of information belongs to exactly one user. If a future feature requires shared data (e.g., shared projects), it will be modeled explicitly with a separate access-control mechanism.

## Multi-User Migration Path

### Step 0: Current State (Single User)

- `user_id` hardcoded in environment variables.
- API key hardcoded in environment variables.
- Webhook token hardcoded in environment variables.
- No auth service. No user table. No JWT.

### Step 1: Auth Service + User Table

- Deploy auth service with user registration and login.
- Create users table in PostgreSQL.
- Issue JWTs on login.
- MCPs still accept API keys (backward compatible).

### Step 2: MCPs Accept JWTs

- MCPs updated to validate JWTs in addition to API keys.
- Deprecate API key auth (keep as fallback for transition).
- Claude Code updated to obtain and refresh JWTs.

### Step 3: Registration and Onboarding

- Registration flow: email + password, email verification.
- Onboarding: create default GTD lists, configure MCPs, issue webhook tokens.
- Admin dashboard for user management.

### Step 4: Per-User MCP Configuration

- Users can connect/disconnect individual MCPs.
- Per-user integration credentials (e.g., Google OAuth tokens).
- Per-user awareness configuration (which data sources are active).

### Timeline

| Step   | Prerequisite         | Effort   |
|--------|----------------------|----------|
| Step 0 | None (current state) | Done     |
| Step 1 | User growth need     | 1-2 days |
| Step 2 | Step 1               | 1 day    |
| Step 3 | Step 2               | 2-3 days |
| Step 4 | Step 3               | 3-5 days |

Do not start Step 1 until there is a concrete need for a second user. The single-user setup is simpler to operate, debug, and evolve.
