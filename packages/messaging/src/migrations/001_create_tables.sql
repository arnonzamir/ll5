-- Messaging MCP: WhatsApp accounts
CREATE TABLE IF NOT EXISTS messaging_whatsapp_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        VARCHAR(255) NOT NULL,
  instance_name  VARCHAR(255) NOT NULL,
  instance_id    VARCHAR(255) NOT NULL,
  api_url        TEXT NOT NULL,
  api_key        TEXT NOT NULL,
  phone_number   VARCHAR(50),
  status         VARCHAR(50) NOT NULL DEFAULT 'disconnected',
  last_error     TEXT,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messaging_wa_accounts_user
  ON messaging_whatsapp_accounts(user_id);

-- Messaging MCP: Telegram accounts
CREATE TABLE IF NOT EXISTS messaging_telegram_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        VARCHAR(255) NOT NULL,
  bot_token      TEXT NOT NULL,
  bot_username   VARCHAR(255),
  bot_name       VARCHAR(255),
  status         VARCHAR(50) NOT NULL DEFAULT 'disconnected',
  last_error     TEXT,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messaging_tg_accounts_user
  ON messaging_telegram_accounts(user_id);

-- Messaging MCP: Conversations (shared across platforms)
CREATE TABLE IF NOT EXISTS messaging_conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          VARCHAR(255) NOT NULL,
  account_id       UUID NOT NULL,
  platform         VARCHAR(20) NOT NULL CHECK (platform IN ('whatsapp', 'telegram')),
  conversation_id  VARCHAR(255) NOT NULL,
  name             VARCHAR(255),
  is_group         BOOLEAN NOT NULL DEFAULT false,
  permission       VARCHAR(20) NOT NULL DEFAULT 'ignore' CHECK (permission IN ('agent', 'input', 'ignore')),
  last_message_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, platform, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_conv_user
  ON messaging_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_messaging_conv_user_platform
  ON messaging_conversations(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_messaging_conv_account
  ON messaging_conversations(account_id);

-- Message send log for tracking daily counts and audit
CREATE TABLE IF NOT EXISTS messaging_send_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      VARCHAR(255) NOT NULL,
  account_id   UUID NOT NULL,
  platform     VARCHAR(20) NOT NULL,
  recipient    VARCHAR(255) NOT NULL,
  message_id   VARCHAR(255),
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messaging_send_log_account_date
  ON messaging_send_log(account_id, sent_at);
