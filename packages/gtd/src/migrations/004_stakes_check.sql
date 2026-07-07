-- GTD MCP: constrain the reconciliation `stakes` domain (DECISION-025, A1 review).
--
-- The deterministic close-gate (reconcile-gate.ts / tools/reconcile.ts) now fails
-- SAFE in code — only the explicit value 'low' auto-closes; anything else routes
-- to human-confirm. This CHECK is the defense-in-depth companion: it stops any
-- writer (a future path, a backfill, a manual SQL fix, a casing/whitespace bug)
-- from ever landing an out-of-domain `stakes` value in the first place, so the
-- {low, consequential} contract is enforced by the DB, not only by convention.
--
-- Safe on existing data: the column is NOT NULL DEFAULT 'consequential' and the
-- only writer is enum-gated ('low'|'consequential'), so every existing row is
-- already in-domain. Idempotent — the runner re-runs every file on every boot.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gtd_horizons_stakes_check'
  ) THEN
    ALTER TABLE gtd_horizons
      ADD CONSTRAINT gtd_horizons_stakes_check CHECK (stakes IN ('low', 'consequential'));
  END IF;
END $$;
