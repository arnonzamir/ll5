import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

/**
 * Index holding the per-user current semantic location label (id = userId).
 * Written by processors/location.ts; read here for scheduler context lines.
 */
export const LOCATION_STATE_INDEX = 'll5_awareness_location_state';

export interface CurrentPlace {
  label: string;
  kind: 'place' | 'city';
  /** ISO timestamp of the last GPS point that confirmed this label, if known. */
  lastSeen?: string;
}

interface LocationStateSource {
  label?: string;
  kind?: 'place' | 'city';
  last_seen?: string;
}

/**
 * Read the user's current semantic place from the location-state doc.
 * Returns null when there's no state yet (or the index is missing) — callers
 * should degrade gracefully (omit the location line).
 */
export async function getCurrentPlace(es: Client, userId: string): Promise<CurrentPlace | null> {
  try {
    const got = await es.get<LocationStateSource>({ index: LOCATION_STATE_INDEX, id: userId });
    const src = got._source;
    if (!src?.label || !src.kind) return null;
    return { label: src.label, kind: src.kind, lastSeen: src.last_seen };
  } catch {
    // No state yet, or index not created — not an error worth surfacing.
    return null;
  }
}

/**
 * Build a short "Location: at <label> (as of <local time>)" line for scheduler
 * system messages (A2 heartbeat, A3 morning briefing). Returns null when there's
 * no usable place or the data is too stale to be worth stating.
 *
 * `maxAgeMs` defaults to 6h: beyond that the user has almost certainly moved and
 * a stale "at Home" line would be misleading.
 */
export async function buildLocationLine(
  es: Client,
  userId: string,
  timezone: string,
  maxAgeMs = 6 * 60 * 60 * 1000,
): Promise<string | null> {
  const place = await getCurrentPlace(es, userId);
  if (!place) return null;

  let asOf = '';
  if (place.lastSeen) {
    const seenMs = new Date(place.lastSeen).getTime();
    if (!Number.isNaN(seenMs)) {
      const ageMs = Date.now() - seenMs;
      if (ageMs > maxAgeMs) {
        logger.debug('[location-state][buildLocationLine] place too stale, omitting', {
          userId,
          label: place.label,
          ageMin: Math.round(ageMs / 60000),
        });
        return null;
      }
      const localTime = new Date(seenMs).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: timezone,
      });
      asOf = ` (as of ${localTime})`;
    }
  }

  // "at Home" for a known place, "in Tel Aviv" for a city-level label.
  const prep = place.kind === 'place' ? 'at' : 'in';
  return `Location: ${prep} ${place.label}${asOf}`;
}
