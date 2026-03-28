import type { PushMessage } from '../../types/message.js';
import type { MessageSearchResult } from '../../types/message.js';

export interface MessageQueryParams {
  from?: string;
  to?: string;
  sender?: string;
  app?: string;
  keyword?: string;
  conversation_id?: string;
  is_group?: boolean;
  limit?: number;
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
}
