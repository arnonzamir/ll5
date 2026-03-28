export interface WhatsAppAccountRecord {
  id: string;
  user_id: string;
  instance_name: string;
  instance_id: string;
  api_url: string;
  api_key: string;
  phone_number: string | null;
  status: 'connected' | 'disconnected' | 'qr_pending';
  last_error: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TelegramAccountRecord {
  id: string;
  user_id: string;
  bot_token: string;
  bot_username: string | null;
  bot_name: string | null;
  status: 'connected' | 'disconnected' | 'token_invalid';
  last_error: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AccountRepository {
  /** List WhatsApp accounts for a user. API keys are NOT decrypted in list. */
  listWhatsApp(userId: string): Promise<WhatsAppAccountRecord[]>;

  /** List Telegram accounts for a user. Bot tokens are NOT decrypted in list. */
  listTelegram(userId: string): Promise<TelegramAccountRecord[]>;

  /** Get a WhatsApp account by ID. Decrypts the API key. */
  getWhatsApp(userId: string, accountId: string): Promise<WhatsAppAccountRecord | null>;

  /** Get a Telegram account by ID. Decrypts the bot token. */
  getTelegram(userId: string, accountId: string): Promise<TelegramAccountRecord | null>;

  /** Find an account (either platform) by ID. Returns platform type. */
  findAccountPlatform(userId: string, accountId: string): Promise<{ platform: 'whatsapp' | 'telegram' } | null>;

  /** Update account connection status and optional last_error. */
  updateStatus(
    userId: string,
    accountId: string,
    platform: 'whatsapp' | 'telegram',
    status: string,
    lastError?: string | null,
  ): Promise<void>;

  /** Update last_seen_at to now. */
  touchLastSeen(
    userId: string,
    accountId: string,
    platform: 'whatsapp' | 'telegram',
  ): Promise<void>;

  /** Get message count sent today for an account. */
  getMessageCountToday(accountId: string): Promise<number>;

  /** Log a sent message. */
  logSentMessage(
    userId: string,
    accountId: string,
    platform: string,
    recipient: string,
    messageId?: string,
  ): Promise<void>;
}
