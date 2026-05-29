import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushCalendarItem } from '../types/index.js';
import { logger } from '../utils/logger.js';

interface CalendarHit {
  _id: string;
  _source?: {
    title?: string;
    description?: string;
    location?: string;
    source?: string;
    start_time?: string;
    end_time?: string;
  };
}

/**
 * Generate a deterministic ID for phone-pushed calendar events
 * to prevent duplicate pushes of the same event.
 *
 * The userId is part of the hash input so two tenants with an identically-titled,
 * same-time event get distinct doc ids in the shared ES index instead of
 * colliding and overwriting each other. The stale-cleanup deleteByQuery in
 * server.ts MUST reconstruct ids with this same input shape.
 */
export function phoneEventId(userId: string, title: string, start: string, end: string): string {
  const hash = crypto.createHash('sha256')
    .update(`${userId}|${title}|${start}|${end}`)
    .digest('hex')
    .slice(0, 16);
  return `phone-${hash}`;
}

/**
 * Search for existing events that overlap with the given time window.
 * Matches events whose start time is within 15 minutes of the pushed event.
 */
async function findOverlappingEvents(
  es: Client,
  userId: string,
  start: string,
  end: string,
): Promise<CalendarHit[]> {
  const startDate = new Date(start);
  const windowStart = new Date(startDate.getTime() - 15 * 60 * 1000).toISOString();
  const windowEnd = new Date(startDate.getTime() + 15 * 60 * 1000).toISOString();

  const response = await es.search({
    index: 'll5_awareness_calendar_events',
    query: {
      bool: {
        filter: [
          { term: { user_id: userId } },
          { range: { start_time: { gte: windowStart, lte: windowEnd } } },
        ],
      },
    },
    size: 10,
  });

  return response.hits.hits as CalendarHit[];
}

/**
 * Process a calendar event push item with dedup:
 * 1. Check for existing events with overlapping time
 * 2. If Google event with empty/generic title found: enrich it with phone data
 * 3. If same event already exists (same title + time): skip
 * 4. Otherwise: write new event
 */
export async function processCalendar(
  es: Client,
  userId: string,
  item: PushCalendarItem,
): Promise<void> {
  const now = new Date().toISOString();

  try {
    const end = item.end ?? item.start;
    const overlapping = await findOverlappingEvents(es, userId, item.start, end);

    for (const hit of overlapping) {
      const existing = hit._source;
      if (!existing) continue;

      // Case 1: Google event with generic/empty title — enrich with phone data
      const isGeneric = existing.source === 'google' && (
        !existing.title ||
        existing.title === '(no title)' ||
        existing.title.toLowerCase() === 'busy' ||
        (!existing.description && item.title)
      );

      if (isGeneric) {
        // Fall back to the EXISTING location, never the existing title — the
        // old code wrote the previous title into location, corrupting the doc
        // (e.g. "Sprint Planning" @ "(no title)").
        const mergedLocation = item.location ?? existing.location;
        const locationSource: 'push' | 'existing' | 'none' = item.location
          ? 'push'
          : existing.location
            ? 'existing'
            : 'none';
        const doc: Record<string, unknown> = {
          title: item.title,
          source: 'merged',
          updated_at: now,
        };
        if (mergedLocation !== undefined) {
          doc.location = mergedLocation;
        }
        await es.update({
          index: 'll5_awareness_calendar_events',
          id: hit._id,
          doc,
        });
        logger.info('[processCalendar][handle] calendar_merge', {
          event_id: hit._id,
          location_source: locationSource,
        });
        return;
      }

      // Case 2: Same title and similar time — skip duplicate
      if (existing.title === item.title) {
        logger.debug('[processCalendar][handle] Skipping duplicate calendar event', { title: item.title });
        return;
      }
    }
  } catch (err) {
    // Dedup is best-effort — don't fail the push if search fails
    logger.warn('[processCalendar][handle] Calendar dedup search failed, writing anyway', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // No match found: write new event with deterministic ID
  const doc: Record<string, unknown> = {
    user_id: userId,
    title: item.title,
    start_time: item.start,
    end_time: item.end ?? item.start,
    source: 'phone',
    all_day: item.all_day ?? false,
    created_at: now,
    updated_at: now,
  };

  if (item.location) {
    doc.location = item.location;
  }
  if (item.calendar_name) {
    doc.calendar_name = item.calendar_name;
  }
  if (item.attendees && item.attendees.length > 0) {
    doc.attendees = item.attendees;
  }
  if (item.description) {
    doc.description = item.description;
  }
  if (item.status) {
    doc.status = item.status;
  }
  if (item.availability) {
    doc.availability = item.availability;
  }

  await es.index({
    index: 'll5_awareness_calendar_events',
    id: phoneEventId(userId, item.title, item.start, item.end ?? item.start),
    document: doc,
    refresh: false,
  });

  logger.debug('[processCalendar][handle] Calendar event stored', {
    title: item.title,
    start: item.start,
  });
}
