// Re-export shared types
export { NotableEventType } from '@ll5/shared';
export type { NotableEvent } from '@ll5/shared';

export const NOTABLE_EVENT_TYPES = [
  'location_change',
  'message_important',
  'calendar_upcoming',
  'entity_status_change',
  'overdue_item',
  'stale_waiting',
] as const;

export const SEVERITY_LEVELS = ['low', 'medium', 'high'] as const;
export type Severity = typeof SEVERITY_LEVELS[number];

export const SEVERITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};
