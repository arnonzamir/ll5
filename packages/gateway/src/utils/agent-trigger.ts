import type { Pool } from 'pg';
import { logger } from './logger.js';
import type { SourceRoutingMeta, SchedulerEventMeta } from './system-message.js';

export interface TriggerPayload {
  content: string;
  metadata?: {
    source?: SourceRoutingMeta;
    scheduler?: SchedulerEventMeta;
  };
  noReply?: boolean;
}

/**
 * Read the user's main agent session ID from user_settings.agent_session_id.
 * Returns null if no session is registered (agent hasn't started / hasn't
 * called POST /internal/agent-session yet).
 */
export async function getAgentSessionId(pool: Pool, userId: string): Promise<string | null> {
  const result = await pool.query<{ agent_session_id: string | null }>(
    'SELECT agent_session_id FROM user_settings WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.agent_session_id ?? null;
}

/**
 * Resolve the opencode server base URL to trigger for a given user.
 *
 * Multi-tenant routing: each user with a running orchestrator container is
 * reachable at the deterministic container name `ll5-agent-<userId>:4096` on the
 * stack network. We route there so one user's triggers never hit another user's
 * container. Fallbacks:
 *  - No OPENCODE_SERVER_URL env → null (Claude Code variant; HTTP trigger is a
 *    no-op, the PG NOTIFY → channel bridge delivers instead).
 *  - Env set but the user has no running per-user container (e.g. the shared
 *    single-agent compose deployment, which has no agent_runtimes row) → the
 *    global OPENCODE_SERVER_URL.
 */
export async function resolveAgentBaseUrl(pool: Pool, userId: string): Promise<string | null> {
  const globalUrl = process.env.OPENCODE_SERVER_URL || null;
  if (!globalUrl) return null; // Claude Code variant — no HTTP trigger.
  try {
    const res = await pool.query<{ status: string }>(
      'SELECT status FROM agent_runtimes WHERE user_id = $1',
      [userId],
    );
    const status = res.rows[0]?.status;
    // A user who has provisioned a per-user container routes to it whenever the
    // container is meant to be up. We include 'error' because the opencode
    // heartbeat can lag (a fresh/among-restart container is marked stale→error
    // before its first heartbeat) — the container is still the right target, and
    // a failed trigger just retries via the sweep. Only a genuinely absent row or
    // a user-'stopped' container falls back to the global URL (shared-agent
    // deployment, which has no agent_runtimes row at all).
    if (status === 'running' || status === 'provisioning' || status === 'error') {
      // Deterministic per-user container name (see agent-orchestrator
      // docker-runtime: `ll5-agent-${userId}`), DNS-resolvable on the network.
      return `http://ll5-agent-${userId}:4096`;
    }
  } catch (err) {
    logger.warn('[agent-trigger] resolveAgentBaseUrl failed — using global URL', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return globalUrl;
}

/**
 * Read a specific worker session ID from the agent_sessions JSONB map.
 * Used by schedulers that target background workers (narrative-loop,
 * reconcile-loop) rather than the main interactive session.
 */
export async function getAgentSessionForWorker(
  pool: Pool,
  userId: string,
  sessionType: string,
): Promise<string | null> {
  const result = await pool.query<{ agent_sessions: Record<string, string> | null }>(
    'SELECT agent_sessions FROM user_settings WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.agent_sessions?.[sessionType] ?? null;
}

/**
 * Trigger the agent to process a message. This is the ONLY variant-specific
 * code path in the gateway, and it's env-driven:
 *
 * - When OPENCODE_SERVER_URL is set (opencode variant): HTTP POST to the
 *   opencode server's prompt_async endpoint with full metadata payload.
 * - When empty (Claude Code variant): no-op. The existing PG NOTIFY ->
 *   channel bridge flow handles delivery.
 *
 * Metadata is injected as a prepended text part BEFORE the content so the
 * agent sees source routing the same way the channel bridge delivered it.
 * (opencode's prompt_async API has no `context` field — metadata must be
 * a `parts` entry, not a separate field.)
 *
 * Errors are NOT swallowed silently — the function logs at warn level and
 * re-throws so the caller can mark the PG row for retry by the
 * stuck-message-sweep (pass A retries triggerAgent alongside pg_notify).
 */
export async function triggerAgent(
  sessionId: string | null,
  payload: TriggerPayload,
  baseUrl?: string | null,
): Promise<void> {
  // Prefer the per-user URL resolved by the caller (resolveAgentBaseUrl); fall
  // back to the global env for back-compat (shared-agent deployments / callers
  // not yet routing per-user).
  const url = baseUrl ?? process.env.OPENCODE_SERVER_URL;
  if (!url || !sessionId) return; // Claude Code variant — no-op

  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text: payload.content }],
  };

  // NOTE: we intentionally do NOT inject a per-turn model here. Each per-user
  // container sets its own default model in opencode.json at boot (entrypoint,
  // from the tenant's provider+model — e.g. opencode-go/deepseek-v4-pro on the Go
  // plan). Injecting the gateway's global OPENCODE_MODEL_ID would override that
  // with the wrong provider/model (e.g. force a go tenant back onto the capped
  // opencode/ endpoint). Model selection lives with the tenant's container.

  if (payload.noReply) {
    body.noReply = true;
  }

  // Metadata is injected as a prepended text part BEFORE the content so
  // the agent sees source routing the same way the channel bridge delivered
  // it. The [meta] prefix lets the agent distinguish context from content.
  // (opencode's API has no `context` field — metadata must be a parts entry.)
  if (payload.metadata) {
    body.parts = [
      { type: 'text', text: `[meta] ${JSON.stringify(payload.metadata)}` },
      ...(body.parts as Array<{ type: string; text: string }>),
    ];
  }

  try {
    const response = await fetch(`${url}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    logger.debug('[agent-trigger] Triggered opencode session', {
      sessionId,
      hasMetadata: !!payload.metadata,
      noReply: !!payload.noReply,
      contentPrefix: payload.content.slice(0, 80),
    });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.warn('[agent-trigger] Failed to trigger opencode session', {
      sessionId,
      error: errMessage,
      contentPrefix: payload.content.slice(0, 80),
    });
    // Re-throw so the caller can mark the PG row for retry by the sweep.
    // The sweep's pass A re-notifies lost pending rows — it now also
    // calls triggerAgent, serving as the redelivery mechanism.
    throw err;
  }
}
