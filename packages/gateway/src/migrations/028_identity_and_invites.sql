-- 028: Identity & invite (BYO-agent tenant platform, Phase 1).
--
-- Adds email+password login identity to auth_users (additive — existing
-- username+PIN login keeps working), plus invite-only signup and typed
-- single-use tokens for password reset / email verification.
-- See docs/design/byo-agent-tenant-platform.md section 3.
--
-- Intentionally avoids the citext extension: we use lower(email) everywhere
-- and a functional unique index for case-insensitive uniqueness.

-- --- auth_users: human-login identity (all nullable / defaulted → backward compatible) ---
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS email          TEXT;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS password_hash  TEXT;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- Case-insensitive uniqueness, only for rows that actually have an email.
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_lower_email
  ON auth_users (lower(email)) WHERE email IS NOT NULL;

-- --- invites: invite-only signup ---
CREATE TABLE IF NOT EXISTS invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL,                 -- sha256 of the emailed token
  invited_by  UUID NOT NULL,                 -- auth_users.user_id of the inviting admin
  role        TEXT NOT NULL DEFAULT 'user',
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites (token_hash);

-- --- auth_tokens: typed, single-use, expiring tokens (password reset / email verify) ---
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,              -- sha256 of the emailed token
  user_id    UUID NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('password_reset','email_verify')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);
