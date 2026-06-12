-- 2026-06-13
--
-- Forward the scheduler name onto the chat NOTIFY payload so the agent's trigger
-- envelope carries WHICH scheduler raised a proactive system message (heartbeat,
-- calendar_review, tickler_alert, ...). The proactivity eval recorder (ll5-run
-- Stop hook) reads it as ground truth for the moment's trigger_class/source
-- instead of guessing from the message text.
--
-- Additive and tiny: we extend the existing `metadata` projection (meta_proj,
-- added in 024 for `kind`) with `scheduler` when present. Scheduler names are
-- short, so this stays far under the 8KB NOTIFY limit. Mirrors 024 exactly
-- otherwise -- only the meta_proj block changes.

CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $body$
DECLARE
  meta_proj jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Maintain chat_conversations counters only for user-facing LL5
    -- channels. channel='system' is ephemeral (scheduler events, escalation
    -- notices, inbound whatsapp-to-system conversions) — each message owns
    -- its conversation_id and does not form a thread.
    IF NEW.channel IN ('web', 'android', 'cli') THEN
      INSERT INTO chat_conversations (conversation_id, user_id, created_at, last_message_at, message_count)
      VALUES (NEW.conversation_id, NEW.user_id, NEW.created_at, NEW.created_at, 1)
      ON CONFLICT (conversation_id) DO UPDATE
        SET message_count   = chat_conversations.message_count + 1,
            last_message_at = GREATEST(chat_conversations.last_message_at, NEW.created_at);
    END IF;

    -- Project just the fields clients care about — keeps payload under
    -- the 8000-byte NOTIFY limit. Add new keys here as new client uses appear.
    meta_proj := NULL;
    IF (NEW.metadata ? 'kind') OR (NEW.metadata ? 'scheduler') THEN
      meta_proj := '{}'::jsonb;
      IF NEW.metadata ? 'kind' THEN
        meta_proj := meta_proj || jsonb_build_object('kind', NEW.metadata -> 'kind');
      END IF;
      IF NEW.metadata ? 'scheduler' THEN
        meta_proj := meta_proj || jsonb_build_object('scheduler', NEW.metadata -> 'scheduler');
      END IF;
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
      'metadata', meta_proj,
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
