-- Trigger to NOTIFY on new inbound chat messages
-- Used by the SSE /chat/listen endpoint

CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $body$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.status = 'pending' THEN
    PERFORM pg_notify('chat_messages', json_build_object(
      'id', NEW.id,
      'conversation_id', NEW.conversation_id,
      'channel', NEW.channel,
      'content', substring(NEW.content from 1 for 200),
      'created_at', NEW.created_at
    )::text);
  END IF;
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_message_notify ON chat_messages;
CREATE TRIGGER chat_message_notify
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION notify_chat_message();
