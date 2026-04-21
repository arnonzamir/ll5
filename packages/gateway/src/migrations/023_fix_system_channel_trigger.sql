-- 2026-04-21 incident fix
--
-- Migration 022 rewrote notify_chat_message() to also INSERT a
-- chat_conversations row for channel IN ('web','android','cli','system').
-- Combined with migration 020's partial-unique index
--
--     CREATE UNIQUE INDEX idx_chat_conversations_one_active
--       ON chat_conversations(user_id) WHERE archived_at IS NULL;
--
-- this breaks every insert that carries a fresh conversation_id on
-- channel='system' (all 55 callers of insertSystemMessage — schedulers,
-- escalation, whatsapp→system conversion). The trigger's ON CONFLICT
-- keys on conversation_id (PK), but the second active row collides on
-- the partial index — raising 23505 and rolling back the chat_messages
-- INSERT. insertSystemMessage swallowed the error at warn level, so
-- the whole proactive layer went dark silently for ~37h (Apr 19 19:28Z
-- → Apr 21 08:20Z).
--
-- Fix: system-channel messages are ephemeral agent prompts — each event
-- gets its own conversation_id by design and never surfaces in the
-- user's chat thread. They have no business participating in the
-- unified active-conversation invariant. Scope the counter-maintenance
-- block to the genuine user-facing channels only.

CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $body$
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

-- Clean up the synthetic chat_conversations rows that migration 020's
-- backfill left behind for channel='system' messages. They clutter
-- list/search endpoints and are pure noise — the rows whose only linked
-- messages are channel='system' were never user-facing threads.
--
-- Scoped to archived_at IS NOT NULL to never touch a user's current
-- active conversation. If the backfill happened to pick a system-only
-- conversation as the newest (archived_at=NULL), leave it alone —
-- getOrCreateActiveConversation already treats it as the active thread
-- and subsequent web/android writes will attach real messages to it.
DELETE FROM chat_conversations c
WHERE c.archived_at IS NOT NULL
  AND c.conversation_id IN (
    SELECT cc.conversation_id
    FROM chat_conversations cc
    JOIN chat_messages m ON m.conversation_id = cc.conversation_id
    WHERE cc.archived_at IS NOT NULL
    GROUP BY cc.conversation_id
    HAVING bool_and(m.channel = 'system')
  );
