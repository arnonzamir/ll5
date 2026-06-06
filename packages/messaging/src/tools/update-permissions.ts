import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit } from '@ll5/shared';

export function registerUpdatePermissionsTool(
  server: McpServer,
  pool: Pool,
  getUserId: () => string,
): void {
  server.tool(
    'update_conversation_permissions',
    "Set the agent's authority (permission) for a conversation: ignore (agent cannot read), " +
      'input (read only), agent (read + can reply). Writes contact_settings.permission — the same ' +
      'field the dashboard Authority control and the permission checker use. ' +
      'To change Delivery/routing instead, use set_contact_settings.',
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

      const result = await pool.query(
        `INSERT INTO contact_settings (user_id, target_type, target_id, permission, platform, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, target_type, target_id)
         DO UPDATE SET permission = EXCLUDED.permission,
                       platform = COALESCE(EXCLUDED.platform, contact_settings.platform),
                       display_name = COALESCE(EXCLUDED.display_name, contact_settings.display_name),
                       updated_at = now()
         RETURNING id`,
        [userId, targetType, targetId, params.permission, params.platform, displayName],
      );

      logAudit({
        user_id: userId,
        source: 'messaging',
        action: 'update',
        entity_type: 'contact_settings',
        entity_id: `${targetType}:${targetId}`,
        summary: `Set ${targetType} ${displayName ?? targetId}: permission=${params.permission}`,
        metadata: { platform: params.platform, conversation_id: params.conversation_id, permission: params.permission, target_type: targetType, target_id: targetId },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            id: result.rows[0]?.id,
            target_type: targetType,
            target_id: targetId,
            permission: params.permission,
          }, null, 2),
        }],
      };
    },
  );
}
