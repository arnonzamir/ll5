import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushCalendarItem } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Process a calendar event push item:
 * 1. Write to ll5_awareness_calendar_events
 */
export async function processCalendar(
  es: Client,
  userId: string,
  item: PushCalendarItem,
): Promise<void> {
  const doc: Record<string, unknown> = {
    user_id: userId,
    title: item.title,
    start: item.start,
    end: item.end,
    source: 'push',
    timestamp: item.timestamp,
  };

  if (item.location) {
    doc.location = item.location;
  }

  if (item.all_day !== undefined) {
    doc.all_day = item.all_day;
  }

  await es.index({
    index: 'll5_awareness_calendar_events',
    id: crypto.randomUUID(),
    document: doc,
    refresh: false,
  });

  logger.debug('Calendar event stored', {
    title: item.title,
    start: item.start,
  });
}
