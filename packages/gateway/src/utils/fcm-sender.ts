import type { Pool } from 'pg';
import { logger } from './logger.js';

interface FCMMessage {
  title: string;
  body: string;
  type: string; // morning_briefing, tickler_alert, im_notification, whatsapp, general
  priority: 'normal' | 'high';
}

export async function sendFCMNotification(
  pool: Pool,
  userId: string,
  message: FCMMessage,
): Promise<void> {
  // Get all FCM tokens for this user
  const result = await pool.query(
    'SELECT token FROM fcm_tokens WHERE user_id = $1',
    [userId],
  );

  if (result.rows.length === 0) {
    logger.debug('[sendFCMNotification] No FCM tokens for user', { userId });
    return;
  }

  const fcmServerKey = process.env.FCM_SERVER_KEY;
  if (!fcmServerKey) {
    logger.debug('[sendFCMNotification] FCM_SERVER_KEY not configured');
    return;
  }

  for (const row of result.rows) {
    try {
      const response = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Authorization': `key=${fcmServerKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: row.token,
          data: {
            type: message.type,
            title: message.title,
            body: message.body,
            priority: message.priority,
          },
          priority: message.priority === 'high' ? 'high' : 'normal',
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn('[sendFCMNotification] FCM send failed', { status: response.status, body: text });
      }
    } catch (err) {
      logger.warn('[sendFCMNotification] FCM send error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
