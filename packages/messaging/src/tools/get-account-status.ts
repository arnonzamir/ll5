import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { TelegramClient } from '../clients/telegram.client.js';

export function registerGetAccountStatusTool(
  server: McpServer,
  accountRepo: AccountRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_account_status',
    'Returns detailed connection health for a specific account, including last error if disconnected.',
    {
      account_id: z.string().describe('Account UUID (WhatsApp or Telegram)'),
    },
    async (params) => {
      const userId = getUserId();

      // Determine which platform the account belongs to
      const platformInfo = await accountRepo.findAccountPlatform(userId, params.account_id);
      if (!platformInfo) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_NOT_FOUND' }) }],
          isError: true,
        };
      }

      const messageCountToday = await accountRepo.getMessageCountToday(params.account_id);

      if (platformInfo.platform === 'whatsapp') {
        const account = await accountRepo.getWhatsApp(userId, params.account_id);
        if (!account) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_NOT_FOUND' }) }],
            isError: true,
          };
        }

        // Live check against Evolution API
        let liveStatus = account.status;
        let lastError = account.last_error;
        try {
          const client = new EvolutionClient(account.api_url, account.instance_name, account.api_key);
          const state = await client.connectionState();
          if (state.state === 'open') {
            liveStatus = 'connected';
            lastError = null;
            await accountRepo.updateStatus(userId, params.account_id, 'whatsapp', 'connected', null);
            await accountRepo.touchLastSeen(userId, params.account_id, 'whatsapp');
          } else {
            liveStatus = state.state === 'close' ? 'disconnected' : (state.state as typeof liveStatus);
            await accountRepo.updateStatus(userId, params.account_id, 'whatsapp', liveStatus, null);
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          liveStatus = 'disconnected';
          await accountRepo.updateStatus(userId, params.account_id, 'whatsapp', 'disconnected', lastError);
        }

        const uptimeSeconds =
          liveStatus === 'connected' && account.last_seen_at
            ? Math.floor((Date.now() - account.last_seen_at.getTime()) / 1000)
            : null;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account_id: account.id,
              platform: 'whatsapp',
              display_name: account.phone_number || account.instance_name,
              status: liveStatus,
              last_seen_at: account.last_seen_at?.toISOString() ?? null,
              last_error: lastError,
              uptime_seconds: uptimeSeconds,
              message_count_today: messageCountToday,
            }, null, 2),
          }],
        };
      } else {
        // Telegram
        const account = await accountRepo.getTelegram(userId, params.account_id);
        if (!account) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_NOT_FOUND' }) }],
            isError: true,
          };
        }

        // Live check against Telegram Bot API
        let liveStatus = account.status;
        let lastError = account.last_error;
        try {
          const client = new TelegramClient(account.bot_token);
          await client.getMe();
          liveStatus = 'connected';
          lastError = null;
          await accountRepo.updateStatus(userId, params.account_id, 'telegram', 'connected', null);
          await accountRepo.touchLastSeen(userId, params.account_id, 'telegram');
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          liveStatus = lastError.includes('401') ? 'token_invalid' : 'disconnected';
          await accountRepo.updateStatus(userId, params.account_id, 'telegram', liveStatus, lastError);
        }

        const uptimeSeconds =
          liveStatus === 'connected' && account.last_seen_at
            ? Math.floor((Date.now() - account.last_seen_at.getTime()) / 1000)
            : null;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              account_id: account.id,
              platform: 'telegram',
              display_name: account.bot_username || account.bot_name || account.id,
              status: liveStatus,
              last_seen_at: account.last_seen_at?.toISOString() ?? null,
              last_error: lastError,
              uptime_seconds: uptimeSeconds,
              message_count_today: messageCountToday,
            }, null, 2),
          }],
        };
      }
    },
  );
}
