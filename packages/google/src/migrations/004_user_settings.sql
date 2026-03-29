-- Per-user settings for the Google MCP
CREATE TABLE IF NOT EXISTS google_user_settings (
  user_id VARCHAR(255) PRIMARY KEY,
  timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Jerusalem',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
