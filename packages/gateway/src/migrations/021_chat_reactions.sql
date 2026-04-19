-- Reactions, compact rendering flag, and nullable content for chat_messages.
-- Reactions are acknowledgment messages with reaction set and content NULL;
-- every other row has content NOT NULL and reaction NULL (XOR constraint).

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS reaction TEXT
    CHECK (reaction IN (
      'acknowledge','reject','agree','disagree','confused','thinking'
    )),
  ADD COLUMN IF NOT EXISTS display_compact BOOLEAN NOT NULL DEFAULT FALSE;

-- Relax content NOT NULL. Existing rows remain non-null (enforced by XOR).
ALTER TABLE chat_messages
  ALTER COLUMN content DROP NOT NULL;

-- XOR: exactly one of content/reaction is set. Empty string vs NULL bites
-- every COUNT(content) and full-text path, so reactions use NULL content.
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_reaction_xor_content
    CHECK ((reaction IS NULL) <> (content IS NULL));

CREATE INDEX IF NOT EXISTS idx_chat_messages_reply_to
  ON chat_messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_reactions
  ON chat_messages(reply_to_id, reaction) WHERE reaction IS NOT NULL;
