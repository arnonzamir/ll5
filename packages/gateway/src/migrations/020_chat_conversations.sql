-- Unified conversations: one active thread per user across web/android/cli.
-- External channels (whatsapp/telegram) keep per-remote_jid conversations unchanged —
-- nothing in this migration touches their routing.

CREATE TABLE IF NOT EXISTS chat_conversations (
  conversation_id UUID PRIMARY KEY,
  user_id         UUID NOT NULL,
  title           TEXT,
  summary         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ,
  message_count   INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ
);

-- Enforce "one active LL5-native conversation per user" at the DB level.
-- Without this, a double-click on "New conversation" races to two actives
-- and the API silently picks one.
--
-- This index is scoped to LL5-native conversations via application logic —
-- WhatsApp/Telegram conversations are not represented in this table, so they
-- can never trigger this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_one_active
  ON chat_conversations(user_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_recent
  ON chat_conversations(user_id, last_message_at DESC);

-- --------------------------------------------------------------------------
-- Backfill from chat_messages
-- --------------------------------------------------------------------------
-- For each distinct (user_id, conversation_id) in chat_messages that isn't
-- from an external channel (whatsapp/telegram), create a chat_conversations
-- row. Active = the user's newest conversation if its last_message_at is
-- within the last 14 days; otherwise archive everything and let the next
-- inbound create a fresh active row.

INSERT INTO chat_conversations (conversation_id, user_id, created_at, last_message_at, message_count, archived_at)
SELECT
  m.conversation_id,
  m.user_id,
  MIN(m.created_at)                                            AS created_at,
  MAX(m.created_at)                                            AS last_message_at,
  COUNT(*)::int                                                AS message_count,
  now()                                                        AS archived_at
FROM chat_messages m
WHERE m.channel IN ('web', 'android', 'cli', 'system')
GROUP BY m.user_id, m.conversation_id
ON CONFLICT (conversation_id) DO NOTHING;

-- For each user, unarchive exactly the most recent conversation IF its
-- last_message_at is within 14 days. Done in a CTE to avoid ties breaking
-- the unique partial index.
WITH newest_per_user AS (
  SELECT DISTINCT ON (user_id)
    conversation_id,
    user_id,
    last_message_at
  FROM chat_conversations
  ORDER BY user_id, last_message_at DESC
)
UPDATE chat_conversations c
SET archived_at = NULL
FROM newest_per_user n
WHERE c.conversation_id = n.conversation_id
  AND n.last_message_at > now() - INTERVAL '14 days';
