import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit } from '@ll5/shared';
import { filePermissionChangeRequest } from './permission-requests.js';

export function registerUpdatePermissionsTool(
  server: McpServer,
  pool: Pool,
  getUserId: () => string,
): void {
  server.tool(
    'update_conversation_permissions',
    "Request a change to the agent's authority (permission) for a conversation: ignore (agent cannot read), " +
      'input (read only), agent (read + can reply). This does NOT apply the change — the conversation authority ' +
      'is a protected setting. The tool files a pending request and the change is applied ONLY after the user ' +
      'approves it with a fingerprint on the phone. To change Delivery/routing instead, use set_contact_settings ' +
      '(routing applies immediately; only permission requires approval).',
    {
      platform: z.enum(['whatsapp', 'telegram']).describe('Platform'),
      conversation_id: z.string().describe('Platform-specific conversation ID'),
      permission: z
        .enum(['agent', 'input', 'ignore'])
        .describe('Authority level: ignore (no read) | input (read only) | agent (read + reply)'),
    },
    async (params) => {
      const userId = getUserId();

      // Resolve the conversation to a contact_settings target. 1:1 chats key on
      // the linked KB person_id; group (and unlinked) chats key on the JID.
      // Mirrors set_contact_settings / the permission checker.
      const contact = await pool.query<{ is_group: boolean; person_id: string | null; display_name: string | null }>(
        `SELECT is_group, person_id, display_name
         FROM messaging_contacts
         WHERE user_id = $1 AND platform = $2 AND platform_id = $3
         LIMIT 1`,
        [userId, params.platform, params.conversation_id],
      );
      const row = contact.rows[0];
      const usePerson = row && row.is_group === false && row.person_id;
      const targetType = usePerson ? 'person' : 'group';
      const targetId = usePerson ? row!.person_id! : params.conversation_id;
      const displayName = row?.display_name ?? null;

      const request = await filePermissionChangeRequest(pool, {
        userId,
        platform: params.platform,
        conversationId: params.conversation_id,
        targetType,
        targetId,
        displayName,
        requestedPermission: params.permission,
      });

      logAudit({
        user_id: userId,
        source: 'messaging',
        action: 'permission_change_requested',
        entity_type: 'contact_settings',
        entity_id: `${targetType}:${targetId}`,
        summary: `Requested authority change for ${targetType} ${displayName ?? targetId}: ${request.currentPermission ?? 'default'} → ${params.permission} (pending fingerprint approval)`,
        metadata: { platform: params.platform, conversation_id: params.conversation_id, requested_permission: params.permission, current_permission: request.currentPermission, target_type: targetType, target_id: targetId, request_id: request.requestId },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            pending_approval: true,
            request_id: request.requestId,
            target_type: targetType,
            target_id: targetId,
            requested_permission: params.permission,
            current_permission: request.currentPermission,
            message: "Permission change requires your fingerprint approval on the phone — NOT applied. The conversation's authority is unchanged until you approve.",
          }, null, 2),
        }],
      };
    },
  );
}
