export enum NotableEventType {
  LOCATION_CHANGE = 'location_change',
  MESSAGE_IMPORTANT = 'message_important',
  CALENDAR_UPCOMING = 'calendar_upcoming',
  ENTITY_STATUS_CHANGE = 'entity_status_change',
  OVERDUE_ITEM = 'overdue_item',
  STALE_WAITING = 'stale_waiting',
}

export interface NotableEvent {
  id: string;
  userId: string;
  type: NotableEventType;
  summary: string;
  details?: Record<string, unknown>;
  acknowledged: boolean;
  timestamp: string;
}
