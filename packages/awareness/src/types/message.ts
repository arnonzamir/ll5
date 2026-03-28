// Re-export shared types
export type { PushMessage, MessageQuery } from '@ll5/shared';

export interface MessageSearchResult {
  id: string;
  timestamp: string;
  sender: string;
  app: string;
  content: string;
  conversation_id: string | null;
  conversation_name: string | null;
  is_group: boolean;
  relevance_score: number | null;
}
