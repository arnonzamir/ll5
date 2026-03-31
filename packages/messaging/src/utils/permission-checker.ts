import type { Pool } from 'pg';

export type ConversationPriority = 'agent' | 'immediate' | 'batch' | 'ignore';

/**
 * Check the unified priority for a conversation by querying notification_rules directly.
 * Returns null if no conversation-specific rule exists (default = batch via batch review).
 */
export async function getConversationPriority(
  pool: Pool,
  userId: string,
  platform: string,
  conversationId: string,
): Promise<ConversationPriority | null> {
  const result = await pool.query<{ priority: string }>(
    `SELECT priority FROM notification_rules
     WHERE user_id = $1 AND rule_type = 'conversation'
     AND match_value = $2 AND platform = $3
     LIMIT 1`,
    [userId, conversationId, platform],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].priority as ConversationPriority;
}
