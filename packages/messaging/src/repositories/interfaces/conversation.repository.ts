export interface ConversationRecord {
  id: string;
  user_id: string;
  account_id: string;
  platform: 'whatsapp' | 'telegram';
  conversation_id: string;
  name: string | null;
  is_group: boolean;
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

  /** Upsert a conversation (used during sync). Preserves existing permission if record exists. */
  upsert(
    userId: string,
    conversation: {
      account_id: string;
      platform: string;
      conversation_id: string;
      name: string;
      is_group: boolean;
    },
  ): Promise<{ created: boolean }>;

  /** Update permission for a conversation. Returns previous permission. */
  updatePermission(
    userId: string,
    platform: string,
    conversationId: string,
    permission: 'agent' | 'input' | 'ignore',
  ): Promise<{ previous_permission: string }>;

  /** Update last_message_at timestamp. */
  touchLastMessage(
    userId: string,
    platform: string,
    conversationId: string,
    timestamp: Date,
  ): Promise<void>;
}
