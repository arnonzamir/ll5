import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { logger } from '../utils/logger.js';

/**
 * get_pairing_qr
 *
 * Returns a fresh QR code (and pairing code) for an existing WhatsApp account
 * by calling Evolution's GET /instance/connect/{name}. Does NOT recreate the
 * instance or the DB row — useful for re-pairing after a logout.
 */
export function registerGetPairingQrTool(
  server: McpServer,
  accountRepo: AccountRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_pairing_qr',
    'Fetch a fresh pairing QR code for an existing WhatsApp account from Evolution API. Used to re-link a WhatsApp number to an already-provisioned instance.',
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
        const qr = await client.connect();
        await accountRepo.updateStatus(userId, params.account_id, 'whatsapp', 'qr_pending', null);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account_id: account.id,
              instance_name: account.instance_name,
              qr: {
                base64: qr.base64,
                pairing_code: qr.pairingCode,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[getPairingQr] Failed', { userId, accountId: params.account_id, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PAIRING_QR_FAILED', message }) }],
          isError: true,
        };
      }
    },
  );
}
