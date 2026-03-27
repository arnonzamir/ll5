import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';

export function registerShoppingTools(server: McpServer, repo: HorizonRepository, getUserId: () => string): void {

  // -------------------------------------------------------------------------
  // manage_shopping_list
  // -------------------------------------------------------------------------
  server.tool(
    'manage_shopping_list',
    'Manage shopping list items. Supports add, remove, check_off, and list operations. Items are stored as actions with list_type=shopping.',
    {
      action: z.enum(['add', 'remove', 'check_off', 'list']).describe('Operation to perform'),
      title: z.string().optional().describe('Item name. Required for add, remove, check_off.'),
      category: z.string().optional().describe('Item category (e.g. "produce", "dairy", "household")'),
      quantity: z.string().optional().describe('Quantity note (e.g. "2 bags", "500g"). Used by add.'),
    },
    async (params) => {
      const userId = getUserId();

      switch (params.action) {
        case 'add': {
          if (!params.title) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: 'title is required for add' }) }],
              isError: true,
            };
          }
          const title = params.quantity ? `${params.title} (${params.quantity})` : params.title;
          const item = await repo.createAction(userId, {
            title,
            listType: 'shopping',
            category: params.category,
            energy: 'low',
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, item }, null, 2) }],
          };
        }

        case 'remove': {
          if (!params.title) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: 'title is required for remove' }) }],
              isError: true,
            };
          }
          const matches = await repo.findActionByTitle(userId, params.title);
          const shoppingMatches = matches.filter((m) => m.listType === 'shopping');
          if (shoppingMatches.length === 0) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `No shopping item found matching "${params.title}"` }) }],
              isError: true,
            };
          }
          const deleted = await repo.deleteAction(userId, shoppingMatches[0].id);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: deleted, item: shoppingMatches[0] }, null, 2) }],
          };
        }

        case 'check_off': {
          if (!params.title) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: 'title is required for check_off' }) }],
              isError: true,
            };
          }
          const matches = await repo.findActionByTitle(userId, params.title);
          const shoppingMatches = matches.filter((m) => m.listType === 'shopping' && m.status === 'active');
          if (shoppingMatches.length === 0) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `No active shopping item found matching "${params.title}"` }) }],
              isError: true,
            };
          }
          const updated = await repo.updateAction(userId, shoppingMatches[0].id, { status: 'completed' });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, item: updated }, null, 2) }],
          };
        }

        case 'list': {
          const result = await repo.listActions(userId, {
            listType: 'shopping',
            status: undefined, // Show all statuses for shopping
            limit: 200,
          });

          // Group by category
          const groups: Record<string, Array<{ id: string; title: string; status: string; category: string | null }>> = {};
          let checkedOff = 0;

          for (const item of result.items) {
            const cat = item.category ?? 'uncategorized';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push({
              id: item.id,
              title: item.title,
              status: item.status,
              category: item.category,
            });
            if (item.status === 'completed') checkedOff++;
          }

          const groupedList = Object.entries(groups).map(([category, items]) => ({
            category,
            items,
          }));

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                shopping_list: {
                  groups: groupedList,
                  total_items: result.total,
                  checked_off: checkedOff,
                },
              }, null, 2),
            }],
          };
        }

        default:
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid action' }) }],
            isError: true,
          };
      }
    },
  );
}
