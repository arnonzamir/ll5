-- 030: Agent connection plane (BYO-agent tenant platform, Phase 3).
--
-- Two tables backing the per-user agent "connection kit":
--   * agent_credentials      — the long-lived, revocable ll5 agent token the
--                              container uses for MCP auth (hash only, never raw).
--   * agent_llm_credentials  — the user's BYO Claude credential, encrypted at
--                              rest (AES-256-GCM, same ENCRYPTION_KEY as google/health).
-- See docs/design/byo-agent-tenant-platform.md sections 3.1 and 4.

-- --- agent_credentials: listable + revocable container→MCP auth tokens ---
CREATE TABLE IF NOT EXISTS agent_credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  name         TEXT NOT NULL DEFAULT 'agent',
  token_hash   TEXT NOT NULL,                 -- sha256 of the issued ll5 agent token
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup by token hash for refresh-time revocation enforcement.
CREATE INDEX IF NOT EXISTS idx_agent_credentials_token_hash ON agent_credentials (token_hash);

-- --- agent_llm_credentials: the user's BYO Claude credential, encrypted ---
CREATE TABLE IF NOT EXISTS agent_llm_credentials (
  user_id      UUID PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('api_key','oauth_setup_token')),
  ciphertext   TEXT NOT NULL,                 -- AES-256-GCM (iv:authTag:ciphertext)
  last4        TEXT,                          -- last 4 chars for display (non-secret)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
