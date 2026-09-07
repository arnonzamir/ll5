-- 2026-09-07 — Delivery contract Phases 3-4 (DECISION-034): the seen model
-- and the learning record.
--
-- user_read_state: the user's chat read position, one row per user,
-- monotonic (POST /me/delivery-events only ever moves it forward). The
-- Android app reports it; desktop tabs do not count as seen (Section 8 #5).
CREATE TABLE IF NOT EXISTS user_read_state (
  user_id          UUID PRIMARY KEY,
  chat_seen_up_to  TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- message_delivery outcome columns filled by the app's delivery events.
-- seen_at already exists (049); listed again so the file is self-describing.
--   seen_at       first of notification_opened / tray_opened / chat_seen_up_to >= created_at
--   shown_at      the phone rendered the notification
--   opened_at     the notification's content intent was tapped
--   dismissed_at  the notification was swiped away
--   feedback      the ask card's "Too much" / "Not enough" (or ok)
--   explored      Phase 4: the modality was an exploration pick, not the policy's
--   policy_bucket the '<class>|<stakes>|<deadline_band>|<mode>' key the pick was made in
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS seen_at       TIMESTAMPTZ;
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS shown_at      TIMESTAMPTZ;
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS opened_at     TIMESTAMPTZ;
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS dismissed_at  TIMESTAMPTZ;
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS feedback      TEXT;
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS explored      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS policy_bucket TEXT;

ALTER TABLE message_delivery DROP CONSTRAINT IF EXISTS message_delivery_feedback_check;
ALTER TABLE message_delivery ADD CONSTRAINT message_delivery_feedback_check
  CHECK (feedback IS NULL OR feedback IN ('too_much', 'not_enough', 'ok'));

-- The stats route scans a user's recent deliveries; the seen derivation
-- updates unseen rows by created_at.
CREATE INDEX IF NOT EXISTS idx_message_delivery_user_created ON message_delivery (user_id, created_at DESC);
