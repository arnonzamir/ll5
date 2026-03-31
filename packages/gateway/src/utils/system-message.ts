import type { Pool } from 'pg';
import { sendFCMNotification } from './fcm-sender.js';
import { logger } from './logger.js';

interface NotifyOptions {
  title: string;
  type: string;
  priority: 'normal' | 'high';
}

/**
 * Insert a system chat message directly into PG.
 * Fire-and-forget: errors are logged but do not propagate.
 * Optionally sends an FCM push notification.
 */
export async function insertSystemMessage(
  pool: Pool,
  userId: string,
  content: string,
  notify?: NotifyOptions,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO chat_messages (user_id, conversation_id, channel, direction, role, content, status, metadata)
       VALUES ($1, gen_random_uuid(), 'system', 'inbound', 'system', $2, 'pending', '{}')`,
      [userId, content],
    );
  } catch (err) {
    logger.warn('[insertSystemMessage] Failed to insert system message', { error: err instanceof Error ? err.message : String(err) });
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
}
