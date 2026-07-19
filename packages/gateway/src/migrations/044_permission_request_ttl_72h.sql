-- 2026-07-19 — Widen the authority-request TTL from 24h to 72h.
--
-- Migration 034 gave permission_change_requests a 24-hour deadline. That is
-- too tight to survive a weekend: four requests filed Friday 2026-07-17 at
-- ~20:30 lapsed Saturday evening, entirely inside Israel's Fri/Sat weekend,
-- and the user never had a waking chance to see the cards.
--
-- 72h means a request filed any evening still stands after two full days, so
-- no ordinary weekend or a day of travel silently consumes it. Expiry itself
-- is unchanged and still fail-safe: PermissionRequestExpiry flips a lapsed row
-- to 'expired' and the requested permission is NOT applied (deny default) —
-- this only widens the window in which the user can say yes.
--
-- DEFAULT only: existing rows keep the expires_at they were written with. The
-- four already-expired rows stay expired; re-filing is the agent's move.
ALTER TABLE permission_change_requests
  ALTER COLUMN expires_at SET DEFAULT now() + interval '72 hours';
