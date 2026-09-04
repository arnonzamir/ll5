import type { PushMessage } from '../../types/message.js';
import type { MessageSearchResult, ConversationVisibility } from '../../types/message.js';

export interface MessageQueryParams {
  from?: string;
  to?: string;
  sender?: string;
  app?: string;
  keyword?: string;
  conversation_id?: string;
  is_group?: boolean;
  limit?: number;
  /** Absolute offset into the result set (cursor pagination, ISS-019). Default 0. */
  offset?: number;
}

export interface MessageRepository {
  /** Full-text search over messages with filters. */
  query(userId: string, params: MessageQueryParams): Promise<MessageSearchResult[]>;

  /** Store a new IM notification. */
  create(userId: string, data: {
    sender: string;
    app: string;
    content: string;
    conversation_id?: string;
    conversation_name?: string;
    is_group?: boolean;
    timestamp: string;
  }): Promise<PushMessage>;

  /** Count conversations with messages in a time range. */
  countActiveConversations(userId: string, since: string): Promise<number>;

  /**
   * Outbound visibility per conversation: "full" when any from_me message
   * exists in the conversation within the trailing window (default 30 days),
   * else "inbound_only". One aggregation query for the whole batch.
   */
  getConversationVisibility(
    userId: string,
    conversationIds: string[],
    windowDays?: number,
  ): Promise<Record<string, ConversationVisibility>>;
}
