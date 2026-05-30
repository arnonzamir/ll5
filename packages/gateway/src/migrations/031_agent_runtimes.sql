-- 031: Agent runtime state (BYO-agent tenant platform, Phase 4/5).
--
-- One row per user tracking the lifecycle of their per-user Claude Code
-- container. The orchestrator service (a separate process, reached over HTTP)
-- owns container placement/launch; the gateway records the resulting state here
-- and the in-container channel MCP heartbeats into last_seen_at.
--
-- status transitions: none → provisioning → running → stopped|error
-- See docs/design/byo-agent-tenant-platform.md sections 5 and 8.

CREATE TABLE IF NOT EXISTS agent_runtimes (
  user_id      UUID PRIMARY KEY,
  container_id TEXT,
  host         TEXT,                          -- which agent host runs it
  status       TEXT NOT NULL DEFAULT 'none'
                 CHECK (status IN ('none','provisioning','running','stopped','error')),
  last_seen_at TIMESTAMPTZ,                   -- channel-MCP heartbeat
  last_error   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
