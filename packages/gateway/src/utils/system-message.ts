import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { sendFCMNotification } from './fcm-sender.js';
import { logger } from './logger.js';

interface NotifyOptions {
  title: string;
  type: string;
  priority: 'normal' | 'high';
}

export interface SchedulerEventMeta {
  scheduler: string;
  event_id: string;
  fired_at: string;
}

export interface SourceRoutingMeta {
  platform: string;         // 'whatsapp', 'telegram'
  remote_jid: string;       // conversation ID on the platform
  account_id?: string;      // messaging account UUID
  sender_name?: string;     // display name of sender
  is_group?: boolean;
  group_name?: string;
}

/**
 * Generate a scheduler event ID and metadata.
 */
export function createSchedulerEvent(schedulerName: string): SchedulerEventMeta {
  return {
    scheduler: schedulerName,
    event_id: `evt_${crypto.randomBytes(6).toString('hex')}`,
    fired_at: new Date().toISOString(),
  };
}

// Failure stats — exported so /admin/health and test harnesses can inspect
// how the proactive layer is actually doing. The Apr 19–21 incident hid
// behind a single logger.warn; we want multiple signals now.
interface InsertFailureStats {
  total_failures: number;
  last_failure_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  recent_by_scheduler: Record<string, number>;
}

const failureStats: InsertFailureStats = {
  total_failures: 0,
  last_failure_at: null,
  last_error: null,
  last_error_code: null,
  recent_by_scheduler: {},
};

export function getSystemMessageFailureStats(): InsertFailureStats {
  return { ...failureStats, recent_by_scheduler: { ...failureStats.recent_by_scheduler } };
}

export function resetSystemMessageFailureStats(): void {
  failureStats.total_failures = 0;
  failureStats.last_failure_at = null;
  failureStats.last_error = null;
  failureStats.last_error_code = null;
  failureStats.recent_by_scheduler = {};
}

/**
 * Insert a system chat message directly into PG.
 * Fire-and-forget: returns null on failure and logs at `error` level so
 * the failure is visible in log explorers. A module-level failure counter
 * is also bumped for /admin/health. Optionally sends an FCM push and
 * attaches scheduler event metadata for audit trail.
 */
export async function insertSystemMessage(
  pool: Pool,
  userId: string,
  content: string,
  notify?: NotifyOptions,
  schedulerEvent?: SchedulerEventMeta,
  sourceRouting?: SourceRoutingMeta,
): Promise<string | null> {
  let messageId: string | null = null;

  // Build metadata
  const metadata: Record<string, unknown> = {};
  if (schedulerEvent) {
    metadata.scheduler = schedulerEvent.scheduler;
    metadata.event_id = schedulerEvent.event_id;
    metadata.fired_at = schedulerEvent.fired_at;
  }
  if (sourceRouting) {
    metadata.source = sourceRouting;
  }

  // Append event_id to content so the agent can reference it
  const fullContent = schedulerEvent
    ? `${content}\n[event_id: ${schedulerEvent.event_id}]`
    : content;

  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO chat_messages (user_id, conversation_id, channel, direction, role, content, status, metadata)
       VALUES ($1, gen_random_uuid(), 'system', 'inbound', 'system', $2, 'pending', $3)
       RETURNING id`,
      [userId, fullContent, JSON.stringify(metadata)],
    );
    messageId = result.rows[0]?.id ?? null;
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const errCode = (err as { code?: string } | null)?.code ?? null;
    failureStats.total_failures += 1;
    failureStats.last_failure_at = new Date().toISOString();
    failureStats.last_error = errMessage;
    failureStats.last_error_code = errCode;
    const schedulerName = schedulerEvent?.scheduler ?? 'ad_hoc';
    failureStats.recent_by_scheduler[schedulerName] =
      (failureStats.recent_by_scheduler[schedulerName] ?? 0) + 1;
    logger.error('[SystemMessage][insert] Failed to insert system message', {
      error: errMessage,
      error_code: errCode,
      user_id: userId,
      scheduler: schedulerEvent?.scheduler ?? null,
      event_id: schedulerEvent?.event_id ?? null,
      content_prefix: fullContent.slice(0, 120),
      total_failures: failureStats.total_failures,
    });
  }

  // Send FCM notification if requested. Fire this even when the DB write
  // failed — the user still needs to know about whatever this message was
  // conveying, and the push is independent of the chat row.
  if (notify) {
    const truncBody = content.length > 200 ? content.slice(0, 200) + '...' : content;
    await sendFCMNotification(pool, userId, {
      title: notify.title,
      body: truncBody,
      type: notify.type,
      priority: notify.priority,
    });
  }

  return messageId;
}
