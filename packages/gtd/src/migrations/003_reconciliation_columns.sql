-- GTD MCP: reconciliation columns on horizon-0 loops (DECISION-025 D4).
--
-- Active context integration matches an inbound signal to the open loop it may
-- resolve. That needs three columns the reconciliation governor + worker read:
--   conversation_id — the linked thread, stamped at loop CREATION, so the
--                     missed-close governor matches EXACTLY (not fuzzy free-text
--                     on `waiting_for`). NULL = the loop is outside the
--                     message-linked selector (the stated honest-scope boundary).
--   stakes          — {low | consequential}. Routes the D5 verification gate:
--                     `consequential` (money/deadline/commitment) is NEVER
--                     autonomously closed — it goes to human-confirm. DEFAULT
--                     'consequential' is FAIL-SAFE: an unclassified loop errs
--                     toward more confirmation, never a silent forged close.
--   reviewed_at     — durable dedup for the worker: advanced ONLY as part of the
--                     same transaction that writes a grounded close/advance/
--                     keep-open. A candidate whose linked conversation has an
--                     inbound newer than reviewed_at is a missed-close candidate.
--
-- All statements idempotent (ADD COLUMN IF NOT EXISTS) — the runner re-runs
-- every file on every boot. The gateway reads these directly (shared ll5 DB).

ALTER TABLE gtd_horizons ADD COLUMN IF NOT EXISTS conversation_id TEXT;
ALTER TABLE gtd_horizons ADD COLUMN IF NOT EXISTS stakes TEXT NOT NULL DEFAULT 'consequential';
ALTER TABLE gtd_horizons ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- Selector index: message-linked, active horizon-0 loops the reconciler scans.
CREATE INDEX IF NOT EXISTS idx_horizons_reconcile
  ON gtd_horizons(user_id, conversation_id)
  WHERE horizon = 0 AND status = 'active' AND conversation_id IS NOT NULL;
