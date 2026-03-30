import type { Pool } from 'pg';
import { logger } from './logger.js';

/**
 * Insert a system chat message directly into PG (no HTTP round-trip).
 * Fire-and-forget: errors are logged but do not propagate.
 *
 * @param dedupMinutes If > 0, checks for a recent system message with the same
 *   prefix (text before the first ']') within the last N minutes. Skips if found.
 *   Default: 0 (no dedup). Set to e.g. 60 for hourly schedulers.
 */
export async function insertSystemMessage(
  pool: Pool,
  userId: string,
  content: string,
  dedupMinutes: number = 0,
): Promise<void> {
  try {
    // Dedup: check for recent similar system message
    if (dedupMinutes > 0) {
      const prefix = content.split(']')[0] + ']';
      const cutoff = new Date(Date.now() - dedupMinutes * 60 * 1000).toISOString();
      const existing = await pool.query(
        `SELECT id FROM chat_messages
         WHERE user_id = $1 AND channel = 'system' AND content LIKE $2 AND created_at > $3
         LIMIT 1`,
        [userId, prefix + '%', cutoff],
      );
      if (existing.rows.length > 0) {
        logger.debug('Skipping duplicate system message', { prefix });
        return;
      }
    }

    await pool.query(
      `INSERT INTO chat_messages (user_id, conversation_id, channel, direction, role, content, status, metadata)
       VALUES ($1, gen_random_uuid(), 'system', 'inbound', 'system', $2, 'pending', '{}')`,
      [userId, content],
    );
  } catch (err) {
    logger.warn('Failed to insert system message', { error: err instanceof Error ? err.message : String(err) });
  }
}
