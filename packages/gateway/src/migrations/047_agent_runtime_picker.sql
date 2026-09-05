-- 2026-09-05 — "alive but stuck on a startup picker" (ISS-029).
-- The process was up, the heartbeat said claude_alive=true, and the agent sat on
-- the dev-channels picker for 40 minutes with 8 triggers pending. The entrypoint
-- now reports picker_visible; the gateway raises agent.picker_stuck after a few
-- minutes of it. This column marks when the picker was first seen (NULL when
-- the pane is clean).
ALTER TABLE agent_runtimes
  ADD COLUMN IF NOT EXISTS picker_since TIMESTAMPTZ;
