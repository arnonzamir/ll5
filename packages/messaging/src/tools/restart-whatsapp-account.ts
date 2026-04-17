import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';

export function registerRestartWhatsAppAccountTool(
  server: McpServer,
  accountRepo: AccountRepository,
  getUserId: () => string,
): void {
  server.tool(
    'restart_whatsapp_account',
    'Restart an Evolution API WhatsApp instance to recover from a ghost-connected Baileys session (state reports "open" but no messages arrive). Returns the state reported by Evolution after the restart.',
    {
      account_id: z.string().describe('WhatsApp account UUID'),
    },
    async (params) => {
      const userId = getUserId();
      const account = await accountRepo.getWhatsApp(userId, params.account_id);
      if (!account) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_NOT_FOUND' }) }],
          isError: true,
        };
      }

      const client = new EvolutionClient(account.api_url, account.instance_name, account.api_key);
      const before = await client.connectionState();

      try {
        const result = await client.restart();
        await accountRepo.updateStatus(userId, params.account_id, 'whatsapp', 'reconnecting', null);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account_id: account.id,
              instance_name: account.instance_name,
              state_before: before.state,
              state_after: result.state,
              note: 'Instance restart issued. It may take 10–30s to reach "open". Poll get_account_status.',
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await accountRepo.updateStatus(userId, params.account_id, 'whatsapp', 'disconnected', message);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'RESTART_FAILED', message, state_before: before.state }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );
}
