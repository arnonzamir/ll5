-- 2026-09-05 — TicklerAlertScheduler dedupe survives gateway restarts.
--
-- The scheduler kept "already alerted today" in memory. Every gateway deploy
-- (five on 2026-09-05) reset it, so the same recurring ticklers ("Ritalin 10mg
-- 17:00", "Day clear?") were re-announced to the agent after each restart:
-- 40 [Tickler Alert] messages in 7 days for a handful of daily items, 26 of 29
-- answered with "suppress". One row per (user, tickler event, local date).
CREATE TABLE IF NOT EXISTS tickler_alerts_sent (
  user_id    UUID NOT NULL,
  event_id   TEXT NOT NULL,
  alert_date DATE NOT NULL,          -- local date in the user's effective timezone
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id, alert_date)
);
