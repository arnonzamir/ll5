-- Update chat_messages INSERT/UPDATE trigger to:
--   1. Maintain chat_conversations counters (message_count, last_message_at)
--      for LL5-native channels only (web/android/cli/system).
--   2. Include reaction, reply_to_id, display_compact in the NOTIFY payload
--      so the channel MCP and dashboard SSE listeners can render without
--      an additional fetch.
--
-- WhatsApp/Telegram rows skip the counter bump — they don't have a
-- chat_conversations row, and we don't want to create one for them.

CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Bump counters for LL5-native conversations. ON CONFLICT keeps this
    -- safe if the row is missing (legacy data or newly-created convo
    -- before the app-level INSERT of chat_conversations lands).
    IF NEW.channel IN ('web', 'android', 'cli', 'system') THEN
      INSERT INTO chat_conversations (conversation_id, user_id, created_at, last_message_at, message_count)
      VALUES (NEW.conversation_id, NEW.user_id, NEW.created_at, NEW.created_at, 1)
      ON CONFLICT (conversation_id) DO UPDATE
        SET message_count   = chat_conversations.message_count + 1,
            last_message_at = GREATEST(chat_conversations.last_message_at, NEW.created_at);
    END IF;

    PERFORM pg_notify('chat_messages', json_build_object(
      'event', 'new_message',
      'id', NEW.id,
      'user_id', NEW.user_id,
      'conversation_id', NEW.conversation_id,
      'channel', NEW.channel,
      'direction', NEW.direction,
      'role', NEW.role,
      'content', CASE WHEN NEW.content IS NULL THEN NULL ELSE substring(NEW.content from 1 for 4000) END,
      'status', NEW.status,
      'reaction', NEW.reaction,
      'reply_to_id', NEW.reply_to_id,
      'display_compact', NEW.display_compact,
      'has_attachments', (NEW.metadata ? 'attachments') IS NOT NULL AND jsonb_array_length(NEW.metadata -> 'attachments') > 0,
      'source', CASE WHEN NEW.metadata ? 'source' THEN NEW.metadata -> 'source' ELSE NULL END,
      'created_at', NEW.created_at
    )::text);
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM pg_notify('chat_messages', json_build_object(
      'event', 'status_update',
      'id', NEW.id,
      'user_id', NEW.user_id,
      'conversation_id', NEW.conversation_id,
      'status', NEW.status
    )::text);
  END IF;
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_message_notify ON chat_messages;
CREATE TRIGGER chat_message_notify
  AFTER INSERT OR UPDATE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION notify_chat_message();

-- --------------------------------------------------------------------------
-- Emit a separate NOTIFY channel for conversation lifecycle events
-- (archive/switch) so open SSE clients can pivot without reconnect.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_chat_conversation() RETURNS trigger AS $body$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    PERFORM pg_notify('chat_conversations', json_build_object(
      'event', 'archived',
      'user_id', NEW.user_id,
      'conversation_id', NEW.conversation_id,
      'summary', NEW.summary,
      'archived_at', NEW.archived_at
    )::text);
  ELSIF TG_OP = 'INSERT' AND NEW.archived_at IS NULL THEN
    PERFORM pg_notify('chat_conversations', json_build_object(
      'event', 'created',
      'user_id', NEW.user_id,
      'conversation_id', NEW.conversation_id,
      'created_at', NEW.created_at
    )::text);
  END IF;
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_conversation_notify ON chat_conversations;
CREATE TRIGGER chat_conversation_notify
  AFTER INSERT OR UPDATE ON chat_conversations
  FOR EACH ROW EXECUTE FUNCTION notify_chat_conversation();
