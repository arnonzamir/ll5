import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';

export function registerListAccountsTool(
  server: McpServer,
  accountRepo: AccountRepository,
  getUserId: () => string,
): void {
  server.tool(
    'list_accounts',
    'List configured WhatsApp and Telegram accounts with connection status.',
    {
      platform: z.enum(['whatsapp', 'telegram']).optional().describe('Filter by platform'),
    },
    async (params) => {
      const userId = getUserId();
      const accounts: Array<{
        account_id: string;
        platform: string;
        display_name: string;
        status: string;
        last_seen_at: string | null;
      }> = [];

      if (!params.platform || params.platform === 'whatsapp') {
        const waAccounts = await accountRepo.listWhatsApp(userId);
        for (const wa of waAccounts) {
          accounts.push({
            account_id: wa.id,
            platform: 'whatsapp',
            display_name: wa.phone_number || wa.instance_name,
            status: wa.status,
            last_seen_at: wa.last_seen_at?.toISOString() ?? null,
          });
        }
      }

      if (!params.platform || params.platform === 'telegram') {
        const tgAccounts = await accountRepo.listTelegram(userId);
        for (const tg of tgAccounts) {
          accounts.push({
            account_id: tg.id,
            platform: 'telegram',
            display_name: tg.bot_username || tg.bot_name || tg.id,
            status: tg.status,
            last_seen_at: tg.last_seen_at?.toISOString() ?? null,
          });
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ accounts }, null, 2) }],
      };
    },
  );
}
