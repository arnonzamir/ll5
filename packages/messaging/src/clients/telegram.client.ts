import { logger } from '../utils/logger.js';

export interface TelegramSendResult {
  success: boolean;
  message_id: number | null;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  from?: { id: number; first_name: string; last_name?: string; username?: string; is_bot: boolean };
  chat: { id: number; type: string; title?: string };
  text?: string;
  reply_to_message?: { message_id: number };
}

/**
 * HTTP client for the Telegram Bot API.
 */
export class TelegramClient {
  private baseUrl: string;

  constructor(private botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  private async request<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/${method}`;

    logger.debug('[TelegramClient][request] Telegram API request', { method });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      logger.error('[TelegramClient][request] Telegram API error', { status: response.status, body: text });
      throw new Error(`Telegram API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram API returned not ok: ${json.description ?? 'unknown'}`);
    }

    return json.result;
  }

  /**
   * Send a text message.
   */
  async sendMessage(
    chatId: string,
    text: string,
    parseMode?: string,
  ): Promise<TelegramSendResult> {
    try {
      const params: Record<string, unknown> = {
        chat_id: chatId,
        text,
      };
      if (parseMode && parseMode !== 'plain') {
        params.parse_mode = parseMode;
      }

      const result = await this.request<{ message_id: number }>('sendMessage', params);

      return {
        success: true,
        message_id: result.message_id,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('[TelegramClient][sendMessage] Telegram sendMessage failed', { error: errorMessage });
      return { success: false, message_id: null };
    }
  }

  /**
   * Get recent updates (messages) from the bot.
   */
  async getUpdates(
    offset?: number,
    limit: number = 20,
  ): Promise<
    Array<{
      update_id: number;
      message?: TelegramMessage;
    }>
  > {
    const params: Record<string, unknown> = { limit };
    if (offset !== undefined) {
      params.offset = offset;
    }

    return this.request<
      Array<{ update_id: number; message?: TelegramMessage }>
    >('getUpdates', params);
  }

  /**
   * Verify bot token by calling getMe.
   */
  async getMe(): Promise<{ id: number; is_bot: boolean; first_name: string; username?: string }> {
    return this.request<{
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    }>('getMe');
  }
}
