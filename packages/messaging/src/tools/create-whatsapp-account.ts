import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import { encrypt } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';

export function registerCreateWhatsAppAccountTool(
  server: McpServer,
  accountRepo: AccountRepository,
  encryptionKey: string,
  getUserId: () => string,
): void {
  server.tool(
    'create_whatsapp_account',
    'Register a WhatsApp account connected via Evolution API. The Evolution API instance must already be running and connected.',
    {
      instance_name: z.string().describe('Evolution API instance name'),
      api_url: z.string().describe('Evolution API base URL (e.g., "http://evolution:8080")'),
      api_key: z.string().describe('Evolution API authentication key'),
      instance_id: z.string().optional().describe('Evolution API instance ID'),
      phone_number: z.string().optional().describe('Phone number connected to WhatsApp'),
    },
    async (params) => {
      const userId = getUserId();

      logger.info('[createWhatsAppAccount] Creating WhatsApp account', {
        userId,
        instanceName: params.instance_name,
        apiUrl: params.api_url,
      });

      try {
        // Encrypt the API key before storage
        const apiKeyEncrypted = encrypt(params.api_key, encryptionKey);

        const account = await accountRepo.createWhatsApp(userId, {
          instance_name: params.instance_name,
          api_url: params.api_url,
          api_key_encrypted: apiKeyEncrypted,
          instance_id: params.instance_id,
          phone_number: params.phone_number,
        });

        logger.info('[createWhatsAppAccount] WhatsApp account created', {
          userId,
          accountId: account.id,
          instanceName: account.instance_name,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              account: {
                id: account.id,
                instance_name: account.instance_name,
                instance_id: account.instance_id,
                api_url: account.api_url,
                api_key: '***',
                phone_number: account.phone_number,
                status: account.status,
                created_at: account.created_at,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 23505 = unique_violation on messaging_wa_instance_name_unique (migration
        // 006): the instance_name is already registered — refuse rather than let
        // it become an ambiguous cross-tenant mapping (DECISION-024 tenant GAP 1).
        const code = (err as { code?: string } | null)?.code;
        if (code === '23505') {
          logger.warn('[createWhatsAppAccount] instance_name already in use', {
            userId,
            instanceName: params.instance_name,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INSTANCE_NAME_TAKEN', instance_name: params.instance_name }) }],
            isError: true,
          };
        }
        logger.error('[createWhatsAppAccount] Failed to create WhatsApp account', {
          userId,
          error: message,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CREATE_FAILED', message }) }],
          isError: true,
        };
      }
    },
  );
}
