-- Messaging MCP: Contacts registry
-- Lightweight lookup table for platform contacts, separate from personal-knowledge People.
CREATE TABLE IF NOT EXISTS messaging_contacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        VARCHAR(255) NOT NULL,
  platform       VARCHAR(50) NOT NULL,        -- 'whatsapp', 'telegram', 'sms'
  platform_id    VARCHAR(255) NOT NULL,        -- JID for WhatsApp, chat_id for Telegram, phone for SMS
  display_name   VARCHAR(255),
  phone_number   VARCHAR(50),
  is_group       BOOLEAN DEFAULT false,
  person_id      VARCHAR(255),                 -- optional link to personal-knowledge person
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, platform, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_contacts_user
  ON messaging_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_messaging_contacts_phone
  ON messaging_contacts(phone_number);
CREATE INDEX IF NOT EXISTS idx_messaging_contacts_name
  ON messaging_contacts(display_name);
