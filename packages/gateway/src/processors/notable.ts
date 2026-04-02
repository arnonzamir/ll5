import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface NotableEventData {
  event_type: string;
  timestamp: string;
  place_id?: string;
  place_name?: string;
  location?: { lat: number; lon: number };
  details?: Record<string, unknown>;
}

/**
 * Write a notable event to ll5_awareness_notable_events.
 * Notable events are significant occurrences like arriving at a known place.
 */
export async function writeNotableEvent(
  es: Client,
  userId: string,
  data: NotableEventData,
): Promise<void> {
  try {
    const doc: Record<string, unknown> = {
      user_id: userId,
      event_type: data.event_type,
      timestamp: data.timestamp,
    };

    if (data.place_id) doc.place_id = data.place_id;
    if (data.place_name) doc.place_name = data.place_name;
    if (data.location) doc.location = data.location;
    if (data.details) doc.details = data.details;

    await es.index({
      index: 'll5_awareness_notable_events',
      id: crypto.randomUUID(),
      document: doc,
      refresh: false,
    });

    logger.info('[writeNotableEvent][index] Notable event created', {
      event_type: data.event_type,
      place_name: data.place_name,
    });
  } catch (err) {
    // Notable events are non-critical — log and continue
    logger.warn('[writeNotableEvent][index] Failed to write notable event', {
      error: err instanceof Error ? err.message : String(err),
      event_type: data.event_type,
    });
  }
}
