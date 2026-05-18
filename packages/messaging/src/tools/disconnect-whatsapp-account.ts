import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { logger } from '../utils/logger.js';

/**
 * disconnect_whatsapp_account
 *
 * Logs the Evolution instance out of WhatsApp (releases the linked-device
 * slot). The Evolution instance and the DB row are kept intact — a subsequent
 * get_pairing_qr call will re-link.
 */
export function registerDisconnectWhatsAppAccountTool(
  server: McpServer,
  accountRepo: AccountRepository,
  getUserId: () => string,
): void {
  server.tool(
    'disconnect_whatsapp_account',
    'Log a WhatsApp account out of its phone (releases the linked-device slot). The Evolution instance and DB row are NOT deleted; the account can be re-paired with get_pairing_qr.',
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

      try {
        const client = new EvolutionClient(account.api_url, account.instance_name, account.api_key);
        await client.logout();
        await accountRepo.updateStatus(userId, params.account_id, 'whatsapp', 'disconnected', null);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              account_id: account.id,
              instance_name: account.instance_name,
              status: 'disconnected',
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[disconnectWhatsAppAccount] Failed', { userId, accountId: params.account_id, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'LOGOUT_FAILED', message }) }],
          isError: true,
        };
      }
    },
  );
}
