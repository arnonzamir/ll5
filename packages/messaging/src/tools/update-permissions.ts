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
    'Set the priority level for a conversation: ignore (drop), batch (periodic summary), immediate (notify agent), agent (notify + agent can respond).',
    {
      platform: z.enum(['whatsapp', 'telegram']).describe('Platform'),
      conversation_id: z.string().describe('Platform-specific conversation ID'),
      permission: z.enum(['agent', 'immediate', 'batch', 'ignore', 'input']).describe('Priority level (input is legacy alias for batch)'),
    },
    async (params) => {
      const userId = getUserId();
      const priority = LEGACY_MAP[params.permission] ?? params.permission;

      // Upsert into notification_rules
      const result = await pool.query(
        `INSERT INTO notification_rules (user_id, rule_type, match_value, priority, platform)
         VALUES ($1, 'conversation', $2, $3, $4)
         ON CONFLICT (user_id, platform, match_value) WHERE rule_type = 'conversation'
         DO UPDATE SET priority = EXCLUDED.priority
         RETURNING id`,
        [userId, params.conversation_id, priority, params.platform],
      );

      logAudit({
        user_id: userId,
        source: 'messaging',
        action: 'update',
        entity_type: 'conversation_permission',
        entity_id: result.rows[0]?.id?.toString() ?? params.conversation_id,
        summary: `Updated ${params.platform} conversation permission to ${priority}: ${params.conversation_id}`,
        metadata: { platform: params.platform, conversation_id: params.conversation_id, priority },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            rule_id: result.rows[0]?.id,
            priority,
          }, null, 2),
        }],
      };
    },
  );
}
