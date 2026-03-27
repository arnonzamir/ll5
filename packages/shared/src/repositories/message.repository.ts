import type { PushMessage, MessageQuery } from '../types/message.js';

export interface MessageRepository {
  query(userId: string, query: MessageQuery): Promise<PushMessage[]>;
  create(userId: string, data: {
    sender: string;
    app: string;
    content: string;
    timestamp: string;
  }): Promise<PushMessage>;
  markProcessed(userId: string, id: string): Promise<void>;
}
