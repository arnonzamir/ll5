import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface NotableEventData {
  event_type: string;
  timestamp: string;
  summary: string;
  severity?: 'low' | 'medium' | 'high';
  payload?: Record<string, unknown>;
}

/**
 * Write a notable event to ll5_awareness_notable_events using the canonical
 * schema that the awareness MCP reader expects. The reader filters on
 * `acknowledged: false` and sorts by `created_at`, so these fields are required.
 *
 * Previously this writer emitted {place_id, place_name, location, details, timestamp}
 * which was silently invisible to get_notable_events.
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
      summary: data.summary,
      severity: data.severity ?? 'low',
      payload: data.payload ?? {},
      acknowledged: false,
      created_at: data.timestamp,
    };

    await es.index({
      index: 'll5_awareness_notable_events',
      id: crypto.randomUUID(),
      document: doc,
      refresh: false,
    });

    logger.info('[writeNotableEvent][index] Notable event created', {
      event_type: data.event_type,
      summary: data.summary,
    });
  } catch (err) {
    logger.warn('[writeNotableEvent][index] Failed to write notable event', {
      error: err instanceof Error ? err.message : String(err),
      event_type: data.event_type,
    });
  }
}
