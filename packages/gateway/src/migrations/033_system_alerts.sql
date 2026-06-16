-- 2026-06-16
--
-- System alert store for the server-side metrics watchdog. One row per
-- (user_id, alert_key); the watchdog upserts it firing/resolved each cycle.
-- This gives alerts durable STATE (vs the old in-memory monitor snapshots),
-- which is what lets us (a) re-notify the agent repeatedly while still firing,
-- (b) escalate the phone push by severity on a cadence, and (c) expose active
-- alerts to the web + Android apps via GET /alerts.
--
-- alert_key examples: 'channel.whatsapp', 'channel.location', 'service.mcp-awareness',
-- 'service.elasticsearch', 'agent.output', 'mcp.tools'.

CREATE TABLE IF NOT EXISTS system_alerts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL,
  alert_key              TEXT NOT NULL,
  severity               TEXT NOT NULL DEFAULT 'warning',  -- warning | critical
  status                 TEXT NOT NULL DEFAULT 'firing',   -- firing | resolved
  summary                TEXT NOT NULL,
  metric_value           TEXT,                             -- the observed value (e.g. "18h", "down")
  expected               TEXT,                             -- the expected value (e.g. "< 1h", "healthy")
  suggestion             TEXT,                             -- one-line fix hint for the agent
  first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_agent_notified_at TIMESTAMPTZ,                      -- last [ALERT] system message to the agent
  last_push_at           TIMESTAMPTZ,                      -- last FCM push to the phone
  notify_count           INT NOT NULL DEFAULT 0,
  resolved_at            TIMESTAMPTZ
);

-- One alert per (user, key): the watchdog upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS system_alerts_user_key_uniq
  ON system_alerts (user_id, alert_key);

-- Fast "what's firing for this user right now" (the /alerts read + re-notify scan).
CREATE INDEX IF NOT EXISTS system_alerts_user_status_idx
  ON system_alerts (user_id, status);
