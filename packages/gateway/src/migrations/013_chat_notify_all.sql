-- Expand NOTIFY trigger to fire on all chat message changes:
-- INSERT (inbound + outbound) and UPDATE (status changes)
-- This enables SSE-based real-time updates for chat clients.

CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- New message (inbound or outbound)
    PERFORM pg_notify('chat_messages', json_build_object(
      'event', 'new_message',
      'id', NEW.id,
      'user_id', NEW.user_id,
      'conversation_id', NEW.conversation_id,
      'channel', NEW.channel,
      'direction', NEW.direction,
      'role', NEW.role,
      'content', substring(NEW.content from 1 for 200),
      'status', NEW.status,
      'metadata', NEW.metadata,
      'created_at', NEW.created_at
    )::text);
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Status change only
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

-- Replace the trigger to also fire on UPDATE
DROP TRIGGER IF EXISTS chat_message_notify ON chat_messages;
CREATE TRIGGER chat_message_notify
  AFTER INSERT OR UPDATE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION notify_chat_message();
