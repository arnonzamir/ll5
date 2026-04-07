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

/**
 * Insert a system chat message directly into PG.
 * Fire-and-forget: errors are logged but do not propagate.
 * Optionally sends an FCM push notification.
 * Optionally attaches scheduler event metadata for audit trail.
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
    logger.warn('[SystemMessage][insert] Failed to insert system message', { error: err instanceof Error ? err.message : String(err) });
  }

  // Send FCM notification if requested
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
