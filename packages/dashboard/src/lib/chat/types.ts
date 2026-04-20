/** Shared chat types — used by both chat-widget (dashboard tile) and the
 *  full-screen chat view. Keep in sync with gateway payload shapes from
 *  packages/gateway/src/chat.ts. */

export interface Attachment {
  type: string;
  url: string;
  filename?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  status?: string;
  created_at: string;
  reply_to_id?: string | null;
  reaction?: string | null;
  display_compact?: boolean;
  metadata?: {
    attachments?: Attachment[];
    kind?: string;
    [key: string]: unknown;
  };
}

export type Reaction =
  | "acknowledge"
  | "reject"
  | "agree"
  | "disagree"
  | "confused"
  | "thinking";

export interface ConversationSummary {
  conversation_id: string;
  title: string | null;
  summary: string | null;
  created_at: string;
  archived_at: string | null;
  last_message_at: string | null;
  message_count: number;
  last_message?: string | null;
  unread_count?: string;
}

export interface ConversationSearchResult {
  conversation_id: string;
  snippet: string;
  matched_at: string;
  title: string | null;
  summary: string | null;
  archived_at: string | null;
  last_message_at: string | null;
  message_count?: number;
}
