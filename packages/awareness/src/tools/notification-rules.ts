import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateToken } from '@ll5/shared';
import { logger } from '../utils/logger.js';

/**
 * Generate a short-lived service token for calling the gateway.
 * Uses the shared AUTH_SECRET so the gateway's chatAuthMiddleware accepts it.
 */
function makeServiceToken(userId: string, authSecret: string): string {
  // 1-day TTL — these are ephemeral, generated per-request
  return generateToken(userId, authSecret, 1, 'service');
}

export function registerNotificationRuleTools(
  server: McpServer,
  getUserId: () => string,
  gatewayUrl: string,
  authSecret: string,
): void {

  server.tool(
    'list_notification_rules',
    'List message notification rules. Rules determine which phone-pushed IM messages are sent immediately to Claude vs batched for periodic review.',
    {},
    async () => {
      const userId = getUserId();
      const token = makeServiceToken(userId, authSecret);

      try {
        const res = await fetch(`${gatewayUrl}/notification-rules`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!res.ok) {
          const body = await res.text();
          logger.error('[list_notification_rules] Failed to list notification rules', { status: res.status, body });
          return {
            content: [{ type: 'text' as const, text: `Error listing rules: ${res.status} ${body}` }],
            isError: true,
          };
        }

        const data = await res.json();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[list_notification_rules] Request failed', { error: msg });
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'create_notification_rule',
    'Create a notification priority rule for phone-pushed IM messages. Immediate rules wake Claude instantly. Batch rules are reviewed periodically.',
    {
      rule_type: z.enum(['sender', 'app', 'keyword', 'group', 'app_direct', 'app_group', 'wildcard']).describe(
        'Match type: sender (name contains), app (all from app), keyword (body contains), group (group name), app_direct (app DMs only), app_group (app group chats only), wildcard (catch-all default). Use * as match_value for broad matches.',
      ),
      match_value: z.string().describe('Value to match (case-insensitive). Use * for wildcard/catch-all.'),
      priority: z.enum(['immediate', 'batch', 'ignore']).optional().describe('Priority: immediate (wake Claude), batch (periodic review), ignore (skip entirely). Default: immediate'),
    },
    async ({ rule_type, match_value, priority }) => {
      const userId = getUserId();
      const token = makeServiceToken(userId, authSecret);

      try {
        const res = await fetch(`${gatewayUrl}/notification-rules`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            rule_type,
            match_value,
            priority: priority ?? 'immediate',
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          logger.error('[create_notification_rule] Failed to create notification rule', { status: res.status, body });
          return {
            content: [{ type: 'text' as const, text: `Error creating rule: ${res.status} ${body}` }],
            isError: true,
          };
        }

        const data = await res.json();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[create_notification_rule] Request failed', { error: msg });
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'delete_notification_rule',
    'Delete a notification priority rule by ID.',
    {
      rule_id: z.string().describe('The rule ID to delete'),
    },
    async ({ rule_id }) => {
      const userId = getUserId();
      const token = makeServiceToken(userId, authSecret);

      try {
        const res = await fetch(`${gatewayUrl}/notification-rules/${rule_id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!res.ok) {
          const body = await res.text();
          logger.error('[delete_notification_rule] Failed to delete notification rule', { status: res.status, body });
          return {
            content: [{ type: 'text' as const, text: `Error deleting rule: ${res.status} ${body}` }],
            isError: true,
          };
        }

        const data = await res.json();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[delete_notification_rule] Request failed', { error: msg });
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
