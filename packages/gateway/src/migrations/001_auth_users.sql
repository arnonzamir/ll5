-- Auth users table for PIN-based token authentication
CREATE TABLE IF NOT EXISTS auth_users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL UNIQUE,
  pin_hash       TEXT NOT NULL,
  name           TEXT,
  token_ttl_days INTEGER NOT NULL DEFAULT 7,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_users_user_id ON auth_users(user_id);
