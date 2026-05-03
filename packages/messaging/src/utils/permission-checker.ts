import type { Pool } from 'pg';

export type ConversationPriority = 'agent' | 'immediate' | 'batch' | 'ignore';

/**
 * Resolve the agent's permission for a conversation. Used by read_messages
 * (blocks 'ignore') and by send_whatsapp / send_telegram (require 'agent').
 *
 * Reads `contact_settings.permission` first — that's the unified field the
 * dashboard writes to. Falls back to the legacy `notification_rules.priority`
 * field for any conversation that hasn't been migrated yet.
 *
 * Returns null when neither table has a row for this conversation. Callers
 * treat null as default-input authority (read OK, send blocked).
 *
 * Mapping from contact_settings.permission (3 values) onto the legacy
 * 4-value type:
 *   permission='agent'  → 'agent'    (read + send)
 *   permission='input'  → 'batch'    (read OK; send blocked — same as legacy 'batch')
 *   permission='ignore' → 'ignore'   (read blocked)
 */
export async function getConversationPriority(
  pool: Pool,
  userId: string,
  platform: string,
  conversationId: string,
): Promise<ConversationPriority | null> {
  // Step 1: contact_settings via messaging_contacts join. Handles both
  // group (target_type='group', target_id=conversation JID) and 1:1
  // (target_type='person', target_id=KB person_id) shapes.
  const csResult = await pool.query<{ permission: string }>(
    `SELECT cs.permission
     FROM messaging_contacts mc
     JOIN contact_settings cs ON cs.user_id = mc.user_id::uuid
       AND (
         (mc.is_group = true  AND cs.target_type = 'group'  AND cs.target_id = mc.platform_id)
         OR
         (mc.is_group = false AND cs.target_type = 'person' AND cs.target_id = mc.person_id)
       )
     WHERE mc.user_id = $1
       AND mc.platform = $2
       AND mc.platform_id = $3
     LIMIT 1`,
    [userId, platform, conversationId],
  );
  if (csResult.rows.length > 0) {
    const perm = csResult.rows[0].permission;
    if (perm === 'agent')  return 'agent';
    if (perm === 'ignore') return 'ignore';
    return 'batch'; // 'input' — read OK, send blocked
  }

  // Step 2: legacy notification_rules fallback.
  const nrResult = await pool.query<{ priority: string }>(
    `SELECT priority FROM notification_rules
     WHERE user_id = $1 AND rule_type = 'conversation'
       AND match_value = $2 AND platform = $3
     LIMIT 1`,
    [userId, conversationId, platform],
  );
  if (nrResult.rows.length === 0) return null;
  return nrResult.rows[0].priority as ConversationPriority;
}
