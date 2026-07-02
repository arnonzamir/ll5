// Re-export shared types
export type { PushMessage, MessageQuery } from '@ll5/shared';

/**
 * Per-conversation outbound visibility (DECISION-020 one-sided-thread guard):
 * "full" = at least one from_me message captured in the trailing window, so
 * both sides of the thread are visible; "inbound_only" = only the peer's side
 * is captured — staleness/"you haven't replied" claims are NOT grounded there.
 */
export type ConversationVisibility = 'full' | 'inbound_only';

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
