-- Add source routing metadata to NOTIFY payload for system messages
-- This lets the channel MCP pass platform/remote_jid to the agent
-- so it can reply on the correct channel without text parsing.

CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('chat_messages', json_build_object(
      'event', 'new_message',
      'id', NEW.id,
      'user_id', NEW.user_id,
      'conversation_id', NEW.conversation_id,
      'channel', NEW.channel,
      'direction', NEW.direction,
      'role', NEW.role,
      'content', substring(NEW.content from 1 for 4000),
      'status', NEW.status,
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
