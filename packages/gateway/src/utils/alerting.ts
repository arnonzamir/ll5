import type { Pool } from 'pg';
import { logger } from './logger.js';
import { insertSystemMessage, createSchedulerEvent } from './system-message.js';
import { sendFCMNotification } from './fcm-sender.js';

/**
 * Central alert spine for the metrics watchdog.
 *
 * Before this, every monitor (whatsapp-flow, phone-liveness, mcp-health, …)
 * FCM-pushed independently, capped at ~2 alerts per episode, kept state only in
 * an in-memory snapshot, and never told the agent. That's why the Jun 15
 * WhatsApp stall went undetected for ~18h. Here, monitors call raiseAlert /
 * clearAlert; the alert row in `system_alerts` carries the durable state, and
 * this module owns the notification policy:
 *
 *   - AGENT (always, repeating): a [ALERT] system message every time the alert
 *     is first seen and then on a re-notify cadence while it keeps firing, so
 *     the agent always knows and is reminded — it decides whether/how to surface
 *     to the user.
 *   - PHONE (severity-based, per the user's decision):
 *       critical → FCM level 'critical' (overrides DND), repeated ~every 30 min.
 *       warning  → FCM level 'alert' once at onset; not repeated (the agent +
 *                  the app banner carry it from there).
 *   - APP banner: GET /alerts reads the firing rows; nothing to push here.
 */

export type AlertSeverity = 'warning' | 'critical';

export interface RaiseAlertInput {
  userId: string;
  /** Stable key, e.g. 'channel.whatsapp' or 'service.mcp-awareness'. */
  key: string;
  severity: AlertSeverity;
  /** One-line human summary, e.g. 'WhatsApp ingestion stalled'. */
  summary: string;
  /** Observed value, e.g. '18h since last message' or 'down'. */
  value?: string;
  /** Expected value, e.g. '< 1h' or 'healthy'. */
  expected?: string;
  /** One-line fix hint surfaced to the agent. */
  suggestion?: string;
}

// Re-notify the agent at most this often while an alert keeps firing.
const AGENT_RENOTIFY_MS = 20 * 60 * 1000; // 20 min
// Re-push the phone for CRITICAL alerts at most this often while firing.
const CRITICAL_PUSH_RENOTIFY_MS = 30 * 60 * 1000; // 30 min

interface AlertRow {
  id: string;
  status: string;
  severity: string;
  first_seen_at: string;
  last_agent_notified_at: string | null;
  last_push_at: string | null;
  notify_count: number;
}

function firingDuration(firstSeenIso: string): string {
  const ms = Date.now() - new Date(firstSeenIso).getTime();
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Record/refresh a firing alert and apply the notification policy.
 * Idempotent: safe to call every monitor cycle while the condition holds.
 */
export async function raiseAlert(pool: Pool, input: RaiseAlertInput): Promise<void> {
  const { userId, key, severity, summary, value, expected, suggestion } = input;
  let row: AlertRow;
  try {
    // Upsert: new row starts firing; an existing row keeps first_seen_at (and,
    // if it was resolved, transitions back to firing and resets the timer).
    const res = await pool.query<AlertRow>(
      `INSERT INTO system_alerts
         (user_id, alert_key, severity, status, summary, metric_value, expected, suggestion,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, 'firing', $4, $5, $6, $7, now(), now())
       ON CONFLICT (user_id, alert_key) DO UPDATE SET
         severity     = EXCLUDED.severity,
         summary      = EXCLUDED.summary,
         metric_value = EXCLUDED.metric_value,
         expected     = EXCLUDED.expected,
         suggestion   = EXCLUDED.suggestion,
         last_seen_at = now(),
         -- coming back from resolved restarts the episode
         status       = 'firing',
         first_seen_at = CASE WHEN system_alerts.status = 'resolved' THEN now() ELSE system_alerts.first_seen_at END,
         last_agent_notified_at = CASE WHEN system_alerts.status = 'resolved' THEN NULL ELSE system_alerts.last_agent_notified_at END,
         last_push_at = CASE WHEN system_alerts.status = 'resolved' THEN NULL ELSE system_alerts.last_push_at END,
         resolved_at  = NULL
       RETURNING id, status, severity, first_seen_at, last_agent_notified_at, last_push_at, notify_count`,
      [userId, key, severity, summary, value ?? null, expected ?? null, suggestion ?? null],
    );
    row = res.rows[0];
  } catch (err) {
    logger.error('[alerting][raiseAlert] upsert failed', {
      key, error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const now = Date.now();
  const agentDue = !row.last_agent_notified_at ||
    now - new Date(row.last_agent_notified_at).getTime() >= AGENT_RENOTIFY_MS;

  // --- AGENT: always, repeating ---
  if (agentDue) {
    const dur = firingDuration(row.first_seen_at);
    const lines = [
      `[ALERT] ${severity.toUpperCase()} — ${summary}`,
      value ? `Observed: ${value}${expected ? `  (expected ${expected})` : ''}` : (expected ? `Expected: ${expected}` : ''),
      `Firing for ${dur}.`,
      suggestion ? `Suggested: ${suggestion}` : '',
      'This is a system health alert. Surface it to the user with appropriate urgency; if a fix tool exists, offer or run it.',
    ].filter(Boolean);
    await insertSystemMessage(pool, userId, lines.join('\n'), undefined, createSchedulerEvent('alert'));
    await pool.query(
      `UPDATE system_alerts SET last_agent_notified_at = now(), notify_count = notify_count + 1 WHERE id = $1`,
      [row.id],
    );
    logger.warn('[alerting][raiseAlert] alert notified to agent', { key, severity, firing_for: dur });
  }

  // --- PHONE: severity-based ---
  const firstPush = !row.last_push_at;
  const criticalRepushDue = severity === 'critical' && row.last_push_at != null &&
    now - new Date(row.last_push_at).getTime() >= CRITICAL_PUSH_RENOTIFY_MS;
  const pushDue = firstPush || criticalRepushDue;
  if (pushDue) {
    try {
      await sendFCMNotification(pool, userId, {
        title: severity === 'critical' ? 'LL5 alert (critical)' : 'LL5 alert',
        body: `${summary}${value ? ` — ${value}` : ''}${suggestion ? `. ${suggestion}` : ''}`,
        type: 'system_alert',
        notification_level: severity === 'critical' ? 'critical' : 'alert',
        data: { alert_key: key, severity },
      });
      await pool.query(`UPDATE system_alerts SET last_push_at = now() WHERE id = $1`, [row.id]);
    } catch (err) {
      logger.error('[alerting][raiseAlert] FCM push failed', {
        key, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Resolve an alert if it is currently firing. On the firing→resolved edge,
 * tell the agent it recovered (and a soft phone recovery if we'd pushed).
 * No-op if there's no firing row for the key.
 */
export async function clearAlert(pool: Pool, userId: string, key: string): Promise<void> {
  let resolved: { summary: string; first_seen_at: string; last_push_at: string | null } | undefined;
  try {
    const res = await pool.query<{ summary: string; first_seen_at: string; last_push_at: string | null }>(
      `UPDATE system_alerts
         SET status = 'resolved', resolved_at = now(), last_seen_at = now()
       WHERE user_id = $1 AND alert_key = $2 AND status = 'firing'
       RETURNING summary, first_seen_at, last_push_at`,
      [userId, key],
    );
    resolved = res.rows[0];
  } catch (err) {
    logger.error('[alerting][clearAlert] update failed', {
      key, error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!resolved) return; // wasn't firing

  const dur = firingDuration(resolved.first_seen_at);
  await insertSystemMessage(
    pool, userId,
    `[ALERT RESOLVED] ${resolved.summary} — recovered after ${dur}.`,
    undefined, createSchedulerEvent('alert'),
  );
  logger.info('[alerting][clearAlert] alert resolved', { key, firing_for: dur });

  if (resolved.last_push_at) {
    try {
      await sendFCMNotification(pool, userId, {
        title: 'LL5 alert resolved',
        body: `${resolved.summary} — recovered after ${dur}.`,
        type: 'system_alert_resolved',
        notification_level: 'silent',
        data: { alert_key: key },
      });
    } catch { /* best effort */ }
  }
}

/** Firing alerts for a user (for GET /alerts). Newest-first. */
export async function getFiringAlerts(pool: Pool, userId: string): Promise<Array<Record<string, unknown>>> {
  const res = await pool.query(
    `SELECT alert_key, severity, summary, metric_value, expected, suggestion,
            first_seen_at, last_seen_at, notify_count
       FROM system_alerts
      WHERE user_id = $1 AND status = 'firing'
      ORDER BY (severity = 'critical') DESC, first_seen_at ASC`,
    [userId],
  );
  return res.rows;
}
