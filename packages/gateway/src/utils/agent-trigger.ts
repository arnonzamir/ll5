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
): Promise<void> {
  const url = process.env.OPENCODE_SERVER_URL;
  if (!url || !sessionId) return; // Claude Code variant — no-op

  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text: payload.content }],
  };

  // Pick the model from the opencode variant's configured provider/model env
  // vars so a fresh opencode session doesn't fall back to its built-in default
  // (claude-sonnet-4-20250514). Format: "opencode/minimax-m3" -> models live at
  // opencode.ai/zen/v1/models for the `opencode` provider.
  const modelId = process.env.OPENCODE_MODEL_ID;
  const providerId = process.env.OPENCODE_PROVIDER_ID ?? 'opencode';
  if (modelId) {
    body.model = { providerID: providerId, modelID: modelId };
  }

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
