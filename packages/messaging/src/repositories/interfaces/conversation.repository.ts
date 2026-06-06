export interface ConversationRecord {
  id: string;
  user_id: string;
  account_id: string;
  platform: 'whatsapp' | 'telegram';
  conversation_id: string;
  name: string | null;
  is_group: boolean;
  is_archived: boolean;
  unread_count: number;
  /**
   * Agent authority, resolved from contact_settings (NOT stored on the row).
   * 'input' when the conversation has no contact_settings entry.
   */
  permission: 'agent' | 'input' | 'ignore';
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationListParams {
  platform?: string;
  permission?: string;
  account_id?: string;
  is_group?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface ConversationListResult {
  conversations: ConversationRecord[];
  total: number;
}

export interface ConversationRepository {
  /** List conversations with optional filters. */
  list(userId: string, params?: ConversationListParams): Promise<ConversationListResult>;

  /** Get a specific conversation by platform and conversation_id. */
  get(userId: string, platform: string, conversationId: string): Promise<ConversationRecord | null>;

  /** Upsert a conversation (used during sync). Touches metadata only; authority lives in contact_settings. */
  upsert(
    userId: string,
    conversation: {
      account_id: string;
      platform: string;
      conversation_id: string;
      name: string;
      is_group: boolean;
      is_archived?: boolean;
      unread_count?: number;
    },
  ): Promise<{ created: boolean }>;

  /** Update last_message_at timestamp. */
  touchLastMessage(
    userId: string,
    platform: string,
    conversationId: string,
    timestamp: Date,
  ): Promise<void>;
}
