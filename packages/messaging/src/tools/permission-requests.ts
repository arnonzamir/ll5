import type { Pool } from 'pg';

/**
 * Defer a conversation-AUTHORITY (permission) change to human approval.
 *
 * The LL5 agent must NOT be able to write contact_settings.permission directly.
 * Instead, the messaging tools call this helper to:
 *   1. read the CURRENT permission from contact_settings (for the approval prompt),
 *   2. INSERT a pending row into permission_change_requests, and
 *   3. NOTIFY the gateway ('permission_approval') so the phone is prompted.
 *
 * The change is applied ONLY by the gateway's POST /approvals/:id/decide endpoint
 * (phone/dashboard-authed). The agent has no path to that endpoint.
 */
export async function filePermissionChangeRequest(
  pool: Pool,
  args: {
    userId: string;
    platform?: string;
    conversationId?: string;
    targetType: 'person' | 'group';
    targetId: string;
    displayName: string | null;
    requestedPermission: 'agent' | 'input' | 'ignore';
  },
): Promise<{ requestId: string; currentPermission: string | null }> {
  // Current permission — what the change would move away from. Surfaced in the
  // approval prompt so the user sees both ends of the change.
  const current = await pool.query<{ permission: string | null }>(
    `SELECT permission FROM contact_settings
     WHERE user_id = $1 AND target_type = $2 AND target_id = $3
     LIMIT 1`,
    [args.userId, args.targetType, args.targetId],
  );
  const currentPermission = current.rows[0]?.permission ?? null;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO permission_change_requests
       (user_id, platform, conversation_id, target_type, target_id, display_name, current_permission, requested_permission, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     RETURNING id`,
    [
      args.userId,
      args.platform ?? null,
      args.conversationId ?? null,
      args.targetType,
      args.targetId,
      args.displayName,
      currentPermission,
      args.requestedPermission,
    ],
  );

  // Wake the gateway's permission_approval listener → FCM push to the phone.
  await pool.query("SELECT pg_notify('permission_approval', $1)", [args.userId]);

  return { requestId: inserted.rows[0]?.id, currentPermission };
}
