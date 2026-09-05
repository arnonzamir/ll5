-- 2026-09-05 — Process liveness on the agent heartbeat (ISS-027 follow-up).
--
-- The container heartbeat (POST /me/agent/heartbeat every 60s) only proved the
-- CONTAINER was alive. On 2026-09-05 03:43Z the claude process died on a
-- startup picker and the container restart-looped for 3h40m while the
-- heartbeat kept beating: the orchestrator saw "running", and the only signal
-- was the silence-inference alert (agent.output) 2h later, pushed to the user
-- 5h later. The heartbeat now carries what the entrypoint can see directly —
-- is the claude process up, for how long, how many launches in the last 10
-- minutes — and the gateway raises agent.process_down / agent.launch_loop
-- from it within minutes.
ALTER TABLE agent_runtimes
  ADD COLUMN IF NOT EXISTS health            JSONB,        -- last heartbeat payload (claude_alive, claude_uptime_s, launches_10m, session_id)
  ADD COLUMN IF NOT EXISTS health_at         TIMESTAMPTZ,  -- when that payload arrived
  ADD COLUMN IF NOT EXISTS claude_down_since TIMESTAMPTZ;  -- first heartbeat that reported claude_alive=false; NULL while alive
