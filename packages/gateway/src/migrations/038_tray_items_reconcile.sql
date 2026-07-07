-- 2026-07-07 — Reconcile-confirm tray items (DECISION-025 A3).
--
-- The human-confirm UX for signal-driven reconciliation. A CONSEQUENTIAL open
-- loop is NEVER autonomously closed (forgery defense): the deterministic gate
-- (reconcile-gate.ts applyReconcile) advances + stamps it and returns
-- 'needs_confirm'. That candidate is enqueued here as a tray_items row with
-- kind='reconcile_confirm', surfaced through GET /me/tray as a one-tap
-- "close this out?" card, and answered via POST /me/reconcile/confirm — which
-- commits the close through the gate's confirmReconcileClose (single writer)
-- and resolves this row.
--
-- loop_id references the gtd_horizons row awaiting confirm. It's nullable so
-- the column is inert for the existing kind='decision' rows.

ALTER TABLE tray_items ADD COLUMN IF NOT EXISTS loop_id UUID;

-- The confirm route resolves the open reconcile_confirm row for a loop, and the
-- enqueue helper guards idempotency on the same predicate.
CREATE INDEX IF NOT EXISTS idx_tray_items_loop_open
  ON tray_items (user_id, loop_id)
  WHERE status = 'open' AND kind = 'reconcile_confirm';
