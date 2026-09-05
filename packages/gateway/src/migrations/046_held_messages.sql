-- 2026-09-05 — Quiet hours (DECISION-030).
--
-- Proactive, non-critical pushes that arrive while the user is asleep or
-- inside the quiet window (default 23:30–06:30 local) are HELD here instead
-- of written to the chat, and released as one digest message when the window
-- ends. Critical (safety/family) passes through; replies to a user who is
-- awake and talking are never held (POST /chat/messages checks recent user
-- activity). Rows are kept after release for the record.
CREATE TABLE IF NOT EXISTS held_messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL,
  content            TEXT NOT NULL,
  notification_level TEXT,
  display_compact    BOOLEAN NOT NULL DEFAULT false,
  metadata           JSONB,
  reason             TEXT NOT NULL,                        -- 'quiet_hours' | 'sleep'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  release_at         TIMESTAMPTZ NOT NULL,
  released_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS held_messages_pending_idx ON held_messages (user_id, release_at) WHERE released_at IS NULL;
