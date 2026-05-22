import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit } from '@ll5/shared';

const LEGACY_MAP: Record<string, string> = { input: 'batch' };

export function registerUpdatePermissionsTool(
  server: McpServer,
  pool: Pool,
  getUserId: () => string,
): void {
  server.tool(
    'update_conversation_permissions',
    'Set the routing for a conversation: ignore (drop), batch (periodic summary), immediate (notify agent), agent (notify + agent can respond).',
    {
      platform: z.enum(['whatsapp', 'telegram']).describe('Platform'),
      conversation_id: z.string().describe('Platform-specific conversation ID'),
      permission: z.enum(['agent', 'immediate', 'batch', 'ignore', 'input']).describe('Routing level (input is legacy alias for batch)'),
    },
    async (params) => {
      const userId = getUserId();
      const routing = LEGACY_MAP[params.permission] ?? params.permission;

      // Resolve the conversation to a contact_settings target. Group chats key on
      // the conversation JID; 1:1 chats key on the linked KB person_id so they
      // resolve through the same person path the matcher uses.
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
        `INSERT INTO contact_settings (user_id, target_type, target_id, routing, platform, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, target_type, target_id)
         DO UPDATE SET routing = EXCLUDED.routing,
                       platform = COALESCE(EXCLUDED.platform, contact_settings.platform),
                       display_name = COALESCE(EXCLUDED.display_name, contact_settings.display_name),
                       updated_at = now()
         RETURNING id`,
        [userId, targetType, targetId, routing, params.platform, displayName],
      );

      logAudit({
        user_id: userId,
        source: 'messaging',
        action: 'update',
        entity_type: 'contact_settings',
        entity_id: `${targetType}:${targetId}`,
        summary: `Set ${targetType} ${displayName ?? targetId}: routing=${routing}`,
        metadata: { platform: params.platform, conversation_id: params.conversation_id, routing, target_type: targetType, target_id: targetId },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            id: result.rows[0]?.id,
            target_type: targetType,
            target_id: targetId,
            routing,
          }, null, 2),
        }],
      };
    },
  );
}
