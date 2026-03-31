import type { Pool } from 'pg';
import { sendFCMNotification } from './fcm-sender.js';
import { logger } from './logger.js';

/**
 * Queue a device command for the Android app and send it via FCM.
 *
 * Flow: insert into device_commands -> send FCM push -> mark as 'sent'.
 * The Android app receives the FCM data message, executes the command,
 * and confirms back via POST /commands/:id/confirm.
 */
export async function queueDeviceCommand(
  pool: Pool,
  userId: string,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  // 1. Insert command with status='pending'
  const result = await pool.query(
    `INSERT INTO device_commands (user_id, command_type, payload)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, commandType, JSON.stringify(payload)],
  );
  const commandId: string = result.rows[0].id;

  // 2. Send FCM data message with command details
  try {
    await sendFCMNotification(pool, userId, {
      title: 'Device Command',
      body: JSON.stringify({ command_id: commandId, command_type: commandType, ...payload }).slice(0, 200),
      type: 'device_command',
      priority: 'high',
      data: {
        command_id: commandId,
        command_type: commandType,
        payload: JSON.stringify(payload),
      },
    });

    // 3. Update status to 'sent'
    await pool.query(
      `UPDATE device_commands SET status = 'sent', fcm_sent_at = now(), updated_at = now() WHERE id = $1`,
      [commandId],
    );

    logger.info('[queueDeviceCommand] Command queued and sent', { commandId, commandType });
  } catch (err) {
    logger.warn('[queueDeviceCommand] FCM send failed, command remains pending', {
      commandId,
      commandType,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return commandId;
}
