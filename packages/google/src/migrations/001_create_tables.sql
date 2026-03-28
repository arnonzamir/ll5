-- Google MCP tables

CREATE TABLE IF NOT EXISTS google_oauth_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       VARCHAR(255) NOT NULL UNIQUE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type    VARCHAR(50) NOT NULL DEFAULT 'Bearer',
  expires_at    TIMESTAMPTZ NOT NULL,
  scopes        TEXT[] DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_oauth_tokens_user_id ON google_oauth_tokens(user_id);

CREATE TABLE IF NOT EXISTS google_calendar_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       VARCHAR(255) NOT NULL,
  calendar_id   VARCHAR(255) NOT NULL,
  calendar_name VARCHAR(255),
  enabled       BOOLEAN DEFAULT true,
  color         VARCHAR(20) DEFAULT '#4285f4',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_config_user_id ON google_calendar_config(user_id);
