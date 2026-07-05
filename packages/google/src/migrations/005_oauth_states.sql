-- Durable OAuth CSRF state store.
-- Replaces the in-memory pendingStates Map so agent/chat-initiated reconnects
-- survive a service restart (or a delayed click) between get_auth_url and the
-- /oauth/callback redirect. Single-use, TTL-bounded rows.
CREATE TABLE IF NOT EXISTS google_oauth_states (
  state       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  scopes      JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Cheap expiry sweeps.
CREATE INDEX IF NOT EXISTS idx_google_oauth_states_expires_at ON google_oauth_states(expires_at);
