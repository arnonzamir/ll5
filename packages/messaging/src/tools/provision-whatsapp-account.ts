import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { encrypt } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';

export interface ProvisionConfig {
  evolutionApiUrl: string | null;
  evolutionGlobalApiKey: string | null;
  gatewayUrl: string | null;
  whatsappWebhookSecret: string | null;
  encryptionKey: string;
}

/**
 * provision_whatsapp_account
 *
 * One-shot create of an Evolution instance + DB row. Returns the initial QR
 * code so the caller (dashboard) can render it for pairing.
 *
 * Distinct from create_whatsapp_account (which only writes the DB row given
 * a pre-existing Evolution instance). This tool does the full provision.
 */
export function registerProvisionWhatsAppAccountTool(
  server: McpServer,
  accountRepo: AccountRepository,
  config: ProvisionConfig,
  getUserId: () => string,
): void {
  server.tool(
    'provision_whatsapp_account',
    'Provision a brand-new WhatsApp account: creates an Evolution API instance with the gateway webhook prefilled, persists the encrypted api_key into messaging_whatsapp_accounts, and returns the initial pairing QR code.',
    {
      instance_name: z
        .string()
        .regex(/^[a-z0-9_]{1,64}$/, 'instance_name must be lowercase letters, digits, or underscore')
        .describe('Evolution API instance name (lowercase letters, digits, underscore)'),
    },
    async (params) => {
      const userId = getUserId();

      // Validate config — required env for provisioning
      if (!config.evolutionApiUrl) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'EVOLUTION_API_URL not configured' }) }],
          isError: true,
        };
      }
      if (!config.evolutionGlobalApiKey) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'EVOLUTION_GLOBAL_API_KEY not configured' }) }],
          isError: true,
        };
      }
      if (!config.gatewayUrl) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'GATEWAY_URL not configured' }) }],
          isError: true,
        };
      }
      if (!config.whatsappWebhookSecret) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'WHATSAPP_WEBHOOK_SECRET not configured' }) }],
          isError: true,
        };
      }

      logger.info('[provisionWhatsAppAccount] Provisioning instance', {
        userId,
        instanceName: params.instance_name,
      });

      try {
        const created = await EvolutionClient.createInstance(
          config.evolutionApiUrl,
          config.evolutionGlobalApiKey,
          {
            instanceName: params.instance_name,
            webhookUrl: `${config.gatewayUrl.replace(/\/$/, '')}/webhook/whatsapp`,
            webhookSecret: config.whatsappWebhookSecret,
          },
        );

        const apiKeyEncrypted = encrypt(created.apiKey, config.encryptionKey);

        const account = await accountRepo.createWhatsApp(userId, {
          instance_name: created.instanceName,
          api_url: config.evolutionApiUrl,
          api_key_encrypted: apiKeyEncrypted,
          instance_id: created.instanceId,
        });

        // Mark qr_pending until paired
        await accountRepo.updateStatus(userId, account.id, 'whatsapp', 'qr_pending', null);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              account: {
                id: account.id,
                instance_name: account.instance_name,
                instance_id: created.instanceId,
                api_url: account.api_url,
                status: 'qr_pending',
              },
              qr: {
                base64: created.qrBase64,
                pairing_code: created.pairingCode,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[provisionWhatsAppAccount] Failed', { userId, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PROVISION_FAILED', message }) }],
          isError: true,
        };
      }
    },
  );
}
