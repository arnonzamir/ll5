import type { Pool } from 'pg';
import { logger } from './logger.js';

/**
 * Insert a system chat message directly into PG.
 * Fire-and-forget: errors are logged but do not propagate.
 */
export async function insertSystemMessage(pool: Pool, userId: string, content: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO chat_messages (user_id, conversation_id, channel, direction, role, content, status, metadata)
       VALUES ($1, gen_random_uuid(), 'system', 'inbound', 'system', $2, 'pending', '{}')`,
      [userId, content],
    );
  } catch (err) {
    logger.warn('Failed to insert system message', { error: err instanceof Error ? err.message : String(err) });
  }
}
