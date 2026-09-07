-- 2026-09-07 — Delivery contract Phase 1 (DECISION-034).
--
-- A message to the user is not sent until it has a path that reaches him.
-- The agent declares a class on every proactive message (fyi / needs-you /
-- do-by); the gateway records the modality it chose, files needs-you and
-- do-by messages as tray `ask` items, and runs the do-by escalation ladder
-- (re-push, alarm, reach) until the user acknowledges.
--
-- message_delivery: one row per classed message — what was sent, how, in
-- which delivery mode, and what happened to it (seen / acknowledged / done /
-- expired / missed). `escalation` carries the planned rungs
-- ({rung, at, level, sent_at?}) plus next_at / ladder_start / initial_push.
CREATE TABLE IF NOT EXISTS message_delivery (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  message_id      UUID NOT NULL,                     -- chat_messages.id
  tray_item_id    UUID,                              -- tray_items.id (needs-you / do-by)
  class           TEXT NOT NULL CHECK (class IN ('fyi', 'needs-you', 'do-by')),
  subject         TEXT,
  stakes          TEXT CHECK (stakes IN ('low', 'medium', 'high', 'critical')),
  due_at          TIMESTAMPTZ,
  modality        TEXT NOT NULL CHECK (modality IN ('chat', 'push_silent', 'push_notify', 'push_alert', 'push_alarm', 'reach')),
  delivery_mode   TEXT,                              -- sleep | quiet_hours | driving | meeting | sick | normal
  hour_local      INT,
  ack_required    BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'acknowledged', 'done', 'expired', 'missed')),
  seen_at         TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  done_at         TIMESTAMPTZ,
  escalation      JSONB,
  rung_sent       INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_delivery_user_status ON message_delivery (user_id, status);
CREATE INDEX IF NOT EXISTS idx_message_delivery_user_message ON message_delivery (user_id, message_id);

-- tray_items gains the `ask` kind. All new columns are nullable so existing
-- decision / reconcile rows are untouched; `options` stays NOT NULL, so an ask
-- row stores '[]'.
ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS subject         TEXT;
ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS due_at          TIMESTAMPTZ;
ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS ack_required    BOOLEAN;
ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS message_id      UUID;
ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS escalation      JSONB;
ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS future_text     TEXT;
ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS done_at         TIMESTAMPTZ;

-- Widen the status check: asks add 'acknowledged' and 'done'.
ALTER TABLE tray_items DROP CONSTRAINT IF EXISTS tray_items_status_check;
ALTER TABLE tray_items ADD CONSTRAINT tray_items_status_check
  CHECK (status IN ('open', 'answered', 'expired', 'acknowledged', 'done'));

CREATE INDEX IF NOT EXISTS idx_tray_items_user_ask_due
  ON tray_items (user_id, due_at)
  WHERE kind = 'ask' AND status IN ('open', 'acknowledged');
