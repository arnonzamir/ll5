-- 2026-07-09 — Agent session heartbeats for worker tracking.
--
-- agent_session_heartbeats: per-worker last-seen timestamp map
-- { narrative-loop, reconcile-loop } updated every cycle so the
-- dashboard can show worker freshness.
--
-- The POST /internal/agent-session handler now also writes the
-- current timestamp into this column on every registration call.

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS agent_session_heartbeats JSONB NOT NULL DEFAULT '{}';
