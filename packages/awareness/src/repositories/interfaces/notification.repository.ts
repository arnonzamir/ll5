/**
 * All-app phone notifications (ll5_awareness_notifications, written by the
 * gateway's processors/app-notification.ts). Read-only from the MCP side.
 */
export interface NotificationRecord {
  id: string;
  package: string;
  app_label: string | null;
  title: string | null;
  text: string | null;
  big_text: string | null;
  category: string | null;
  channel_id: string | null;
  ongoing: boolean;
  posted_at: string;
  received_at: string;
  removed_at: string | null;
}

export interface NotificationQueryParams {
  package?: string;
  /** Fuzzy match on app_label. */
  app?: string;
  since?: string;
  until?: string;
  /** Full-text search over title / text / big_text. */
  search?: string;
  /** Default false: ongoing (persistent) notifications are excluded. */
  include_ongoing?: boolean;
  limit?: number;
  offset?: number;
}

export interface NotificationRepository {
  /** Newest first (or by relevance when `search` is set). */
  query(userId: string, params: NotificationQueryParams): Promise<NotificationRecord[]>;
  /** Non-ongoing notifications received since `since`, newest first, at most `limit`. */
  recent(userId: string, since: string, limit: number): Promise<NotificationRecord[]>;
}
