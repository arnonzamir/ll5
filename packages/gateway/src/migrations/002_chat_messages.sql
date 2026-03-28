CREATE TABLE IF NOT EXISTS chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  conversation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  channel         TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'whatsapp', 'cli')),
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  reply_to_id     UUID REFERENCES chat_messages(id),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_status ON chat_messages(user_id, status, direction);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(user_id, channel, created_at DESC);
