import { BasePostgresRepository } from './base.repository.js';
import type {
  AccountRepository,
  WhatsAppAccountRecord,
  TelegramAccountRecord,
} from '../interfaces/account.repository.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

export class PostgresAccountRepository extends BasePostgresRepository implements AccountRepository {
  constructor(pool: import('pg').Pool, private encryptionKey: string) {
    super(pool);
  }

  async listWhatsApp(userId: string): Promise<WhatsAppAccountRecord[]> {
    const rows = await this.query<WhatsAppAccountRecord>(
      `SELECT id, user_id, instance_name, instance_id, api_url,
              '***' AS api_key, phone_number, status, last_error,
              last_seen_at, created_at, updated_at
       FROM messaging_whatsapp_accounts
       WHERE user_id = $1
       ORDER BY created_at`,
      [userId],
    );
    return rows;
  }

  async listTelegram(userId: string): Promise<TelegramAccountRecord[]> {
    const rows = await this.query<TelegramAccountRecord>(
      `SELECT id, user_id, '***' AS bot_token, bot_username, bot_name,
              status, last_error, last_seen_at, created_at, updated_at
       FROM messaging_telegram_accounts
       WHERE user_id = $1
       ORDER BY created_at`,
      [userId],
    );
    return rows;
  }

  async getWhatsApp(userId: string, accountId: string): Promise<WhatsAppAccountRecord | null> {
    const row = await this.queryOne<WhatsAppAccountRecord>(
      `SELECT * FROM messaging_whatsapp_accounts
       WHERE user_id = $1 AND id = $2`,
      [userId, accountId],
    );
    if (row) {
      row.api_key = decrypt(row.api_key, this.encryptionKey);
    }
    return row;
  }

  async getTelegram(userId: string, accountId: string): Promise<TelegramAccountRecord | null> {
    const row = await this.queryOne<TelegramAccountRecord>(
      `SELECT * FROM messaging_telegram_accounts
       WHERE user_id = $1 AND id = $2`,
      [userId, accountId],
    );
    if (row) {
      row.bot_token = decrypt(row.bot_token, this.encryptionKey);
    }
    return row;
  }

  async findAccountPlatform(
    userId: string,
    accountId: string,
  ): Promise<{ platform: 'whatsapp' | 'telegram' } | null> {
    const wa = await this.queryOne<{ id: string }>(
      `SELECT id FROM messaging_whatsapp_accounts WHERE user_id = $1 AND id = $2`,
      [userId, accountId],
    );
    if (wa) return { platform: 'whatsapp' };

    const tg = await this.queryOne<{ id: string }>(
      `SELECT id FROM messaging_telegram_accounts WHERE user_id = $1 AND id = $2`,
      [userId, accountId],
    );
    if (tg) return { platform: 'telegram' };

    return null;
  }

  async updateStatus(
    userId: string,
    accountId: string,
    platform: 'whatsapp' | 'telegram',
    status: string,
    lastError?: string | null,
  ): Promise<void> {
    const table =
      platform === 'whatsapp'
        ? 'messaging_whatsapp_accounts'
        : 'messaging_telegram_accounts';

    await this.query(
      `UPDATE ${table}
       SET status = $1, last_error = $2, updated_at = now()
       WHERE user_id = $3 AND id = $4`,
      [status, lastError ?? null, userId, accountId],
    );
  }

  async touchLastSeen(
    userId: string,
    accountId: string,
    platform: 'whatsapp' | 'telegram',
  ): Promise<void> {
    const table =
      platform === 'whatsapp'
        ? 'messaging_whatsapp_accounts'
        : 'messaging_telegram_accounts';

    await this.query(
      `UPDATE ${table}
       SET last_seen_at = now(), updated_at = now()
       WHERE user_id = $1 AND id = $2`,
      [userId, accountId],
    );
  }

  async getMessageCountToday(accountId: string): Promise<number> {
    return this.queryCount(
      `SELECT COUNT(*) AS count FROM messaging_send_log
       WHERE account_id = $1 AND sent_at >= CURRENT_DATE`,
      [accountId],
    );
  }

  async logSentMessage(
    userId: string,
    accountId: string,
    platform: string,
    recipient: string,
    messageId?: string,
  ): Promise<void> {
    await this.query(
      `INSERT INTO messaging_send_log (user_id, account_id, platform, recipient, message_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, accountId, platform, recipient, messageId ?? null],
    );
  }

  async createWhatsApp(
    userId: string,
    data: {
      instance_name: string;
      api_url: string;
      api_key_encrypted: string;
      instance_id?: string;
      phone_number?: string;
    },
  ): Promise<WhatsAppAccountRecord> {
    const row = await this.queryOne<WhatsAppAccountRecord>(
      `INSERT INTO messaging_whatsapp_accounts
         (user_id, instance_name, instance_id, api_url, api_key, phone_number, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'disconnected')
       RETURNING id, user_id, instance_name, instance_id, api_url,
                 '***' AS api_key, phone_number, status, last_error,
                 last_seen_at, created_at, updated_at`,
      [
        userId,
        data.instance_name,
        data.instance_id ?? '',
        data.api_url,
        data.api_key_encrypted,
        data.phone_number ?? null,
      ],
    );
    if (!row) {
      throw new Error('[PostgresAccountRepository][createWhatsApp] INSERT did not return a row');
    }
    return row;
  }
}
