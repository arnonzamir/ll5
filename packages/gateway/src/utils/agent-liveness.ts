import type { Pool } from 'pg';
import { logger } from './logger.js';
import { raiseAlert, clearAlert } from './alerting.js';

/**
 * Process liveness from the agent container's heartbeat (ISS-027, 2026-09-05).
 *
 * The heartbeat used to be an empty POST that only proved the CONTAINER was up.
 * When claude itself died on a startup picker and the container restart-looped
 * for 3h40m, the heartbeat kept beating and the orchestrator saw "running"; the
 * first alert was the silence-inference one (agent.output) two hours later.
 * The entrypoint now reports what it can observe directly, and this module
 * turns it into two fast, cause-level alerts:
 *   agent.process_down  — claude_alive=false for ≥ PROCESS_DOWN_AFTER_MS
 *   agent.launch_loop   — ≥ LAUNCH_LOOP_MIN launches in the last 10 minutes
 * Symptom checks (agent.output, loop.*, throughput.*) suppress themselves while
 * one of these is firing, so one root cause produces one alert.
 */
export interface HeartbeatHealth {
  claude_alive: boolean;
  claude_uptime_s: number;
  launches_10m: number;
  /** A startup picker ("Enter to confirm") is on the tmux pane: alive but not working (ISS-029). */
  picker_visible: boolean;
  session_id: string | null;
}

export const PROCESS_DOWN_AFTER_MS = 3 * 60 * 1000;
export const PICKER_STUCK_AFTER_MS = 3 * 60 * 1000;
export const LAUNCH_LOOP_MIN = 3;
export const LIVENESS_ALERT_KEYS = ['agent.process_down', 'agent.launch_loop', 'agent.picker_stuck'] as const;

/** Accepts the heartbeat body; returns null for the legacy empty `{}` heartbeat. */
export function parseHeartbeatHealth(body: unknown): HeartbeatHealth | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.claude_alive !== 'boolean') return null;
  const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    claude_alive: b.claude_alive,
    claude_uptime_s: int(b.claude_uptime_s),
    launches_10m: int(b.launches_10m),
    picker_visible: b.picker_visible === true,
    session_id: typeof b.session_id === 'string' && b.session_id ? b.session_id.slice(0, 64) : null,
  };
}

/**
 * Store the payload on agent_runtimes (the row already exists — the heartbeat
 * handler upserts it first) and raise/clear the two liveness alerts.
 */
export async function recordHeartbeatHealth(pool: Pool, userId: string, h: HeartbeatHealth, now = Date.now()): Promise<void> {
  const res = await pool.query<{ claude_down_since: Date | null; picker_since: Date | null }>(
    `UPDATE agent_runtimes SET
       health = $2::jsonb,
       health_at = now(),
       claude_down_since = CASE
         WHEN $3::boolean THEN NULL
         WHEN claude_down_since IS NULL THEN now()
         ELSE claude_down_since END,
       picker_since = CASE
         WHEN NOT $4::boolean THEN NULL
         WHEN picker_since IS NULL THEN now()
         ELSE picker_since END,
       updated_at = now()
     WHERE user_id = $1
     RETURNING claude_down_since, picker_since`,
    [userId, JSON.stringify(h), h.claude_alive, h.picker_visible],
  );
  const downSince = res.rows[0]?.claude_down_since ?? null;
  const pickerSince = res.rows[0]?.picker_since ?? null;

  // ISS-029: alive but parked on a startup picker — the process check cannot see it.
  if (h.picker_visible) {
    const stuckMs = pickerSince ? now - new Date(pickerSince).getTime() : 0;
    if (stuckMs >= PICKER_STUCK_AFTER_MS) {
      logger.error('[agent][liveness] claude stuck on a startup picker', { userId, stuckMinutes: Math.round(stuckMs / 60000) });
      await raiseAlert(pool, {
        userId,
        key: 'agent.picker_stuck',
        severity: 'critical',
        summary: 'Agent is parked on a startup picker (alive, not working)',
        value: `picker visible ${Math.round(stuckMs / 60000)}m`,
        expected: 'chat input within 2 minutes of launch',
        suggestion: 'tmux capture-pane -t ll5 -p in the ll5-agent container shows the prompt; move the pointer off any Exit option and press Enter (the dismisser in ll5-server / docker-entrypoint.sh should have — check "picker dismissal done" in the logs).',
      });
    }
  } else {
    await clearAlert(pool, userId, 'agent.picker_stuck');
  }

  if (h.claude_alive) {
    await clearAlert(pool, userId, 'agent.process_down');
  } else {
    const downMs = downSince ? now - new Date(downSince).getTime() : 0;
    if (downMs >= PROCESS_DOWN_AFTER_MS) {
      logger.error('[agent][liveness] claude process down', { userId, downMinutes: Math.round(downMs / 60000), launches_10m: h.launches_10m });
      await raiseAlert(pool, {
        userId,
        key: 'agent.process_down',
        severity: 'critical',
        summary: 'Agent process is not running (container alive, claude down)',
        value: `down ${Math.round(downMs / 60000)}m`,
        expected: 'claude process up',
        suggestion: 'The container is up but claude exited. Check ~/.ll5/claude.log in the ll5-agent container for the last screen (startup picker, crash) — a relaunch loop shows as agent.launch_loop.',
      });
    }
  }

  if (h.launches_10m >= LAUNCH_LOOP_MIN) {
    logger.error('[agent][liveness] claude launch loop', { userId, launches_10m: h.launches_10m });
    await raiseAlert(pool, {
      userId,
      key: 'agent.launch_loop',
      severity: 'critical',
      summary: 'Agent is relaunching in a loop',
      value: `${h.launches_10m} launches in 10m`,
      expected: `< ${LAUNCH_LOOP_MIN}`,
      suggestion: 'claude exits right after launch — almost always a startup picker/prompt the auto-dismiss did not handle (see ISS-027) or a bad flag. Read ~/.ll5/claude.log; do not just restart the container.',
    });
  } else {
    await clearAlert(pool, userId, 'agent.launch_loop');
  }
}

/**
 * Keys of the liveness alerts currently firing for a user — used by the
 * symptom-level monitors to stay quiet while the cause is already alerted.
 * Never throws: on a DB error nothing is suppressed (a duplicate alert beats a
 * masked outage).
 */
export async function firingAlertKeys(pool: Pool, userId: string): Promise<Set<string>> {
  try {
    const res = await pool.query<{ alert_key: string }>(
      `SELECT alert_key FROM system_alerts WHERE user_id = $1 AND status = 'firing'`,
      [userId],
    );
    return new Set(res.rows.map((r) => r.alert_key));
  } catch (err) {
    logger.warn('[agent][liveness] firingAlertKeys failed — not suppressing', { userId, error: err instanceof Error ? err.message : String(err) });
    return new Set();
  }
}
