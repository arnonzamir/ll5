-- 2026-07-08 — Agent session registration (dual-run-variant Phase 2).
--
-- The agent container registers its opencode session on startup via
-- POST /internal/agent-session. The gateway stores the session ID here so
-- triggerAgent() can route prompts to the right session without a static
-- env var (which the agent can't modify at runtime).
--
-- agent_session_id: the MAIN interactive session (the one triggerAgent
--   targets for user-facing prompts). Fast single-column read — the common
--   case for insertSystemMessage -> triggerAgent.
-- agent_sessions: per-worker session map { main, narrative-loop,
--   reconcile-loop } for schedulers that target specific background workers.
--   JSONB shallow-merge on UPSERT (|| operator) so worker registrations
--   don't clobber the main session or each other.

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS agent_session_id TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS agent_sessions JSONB NOT NULL DEFAULT '{}';
