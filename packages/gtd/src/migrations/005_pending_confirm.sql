-- GTD MCP: pending_confirm flag on horizon-0 loops (DECISION-025 human-confirm wiring).
--
-- When a signal-driven reconcile tries to CLOSE a `consequential` loop, the gate
-- never auto-closes it (forgery defense) — it advances + stamps reviewed_at and
-- returns needs_confirm. This flag is how that "surface it for the user's one-tap
-- confirm" step is wired WITHOUT crossing domains: GTD sets pending_confirm=true
-- on its OWN table, atomically with the advance; the gateway's reconcile governor
-- (which already reads gtd_horizons) scans pending_confirm=true active loops and
-- enqueues the reconcile_confirm tray card into its OWN tray_items table, then
-- clears the flag. No cross-MCP write, no second writer in the mutation path.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); the runner re-runs every file on boot.

ALTER TABLE gtd_horizons ADD COLUMN IF NOT EXISTS pending_confirm BOOLEAN NOT NULL DEFAULT false;

-- The governor scans this: consequential loops advanced-not-closed awaiting a card.
CREATE INDEX IF NOT EXISTS idx_horizons_pending_confirm
  ON gtd_horizons(user_id)
  WHERE horizon = 0 AND status = 'active' AND pending_confirm = true;
