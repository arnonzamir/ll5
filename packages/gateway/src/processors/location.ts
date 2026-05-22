import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushLocationItem } from '../types/index.js';
import { reverseGeocode } from '../utils/geocoding.js';
import type { GeocodingResult } from '../utils/geocoding.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';
import { writeNotableEvent } from './notable.js';

interface PlaceHit {
  _id?: string;
  _source?: {
    name?: string;
    user_id?: string;
  };
}

interface PlaceMatchResult {
  place_id: string;
  place_name: string;
}

interface PreviousLocationHit {
  _source?: {
    location?: { lat: number; lon: number };
    address?: string;
    matched_place?: string;
    timestamp?: string;
  };
}

/**
 * Haversine distance between two points in km.
 */
function haversine(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinLon *
      sinLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Query ll5_knowledge_places for a known place within 100m of the given coordinates.
 */
async function matchKnownPlace(
  es: Client,
  userId: string,
  lat: number,
  lon: number,
): Promise<PlaceMatchResult | null> {
  try {
    const response = await es.search({
      index: 'll5_knowledge_places',
      query: {
        bool: {
          filter: [
            { term: { user_id: userId } },
            {
              geo_distance: {
                distance: '100m',
                geo: { lat, lon },
              },
            },
          ],
        },
      },
      size: 1,
    });

    const hits = response.hits.hits as PlaceHit[];
    if (hits.length > 0 && hits[0]._id && hits[0]._source?.name) {
      return {
        place_id: hits[0]._id,
        place_name: hits[0]._source.name,
      };
    }

    return null;
  } catch (err) {
    logger.warn('[location][matchKnownPlace] Place matching failed', {
      error: err instanceof Error ? err.message : String(err),
      lat,
      lon,
    });
    return null;
  }
}

/**
 * Query the previous location point from ES.
 * Returns the most recent point before the current one.
 */
async function getPreviousLocation(
  es: Client,
  userId: string,
): Promise<PreviousLocationHit['_source'] | null> {
  try {
    const response = await es.search({
      index: 'll5_awareness_locations',
      query: {
        bool: {
          filter: [{ term: { user_id: userId } }],
        },
      },
      sort: [{ timestamp: { order: 'desc' } }],
      size: 1,
    });

    const hits = response.hits.hits as PreviousLocationHit[];
    if (hits.length > 0 && hits[0]._source?.location) {
      return hits[0]._source;
    }
    return null;
  } catch (err) {
    logger.warn('[location][getPreviousLocation] Failed to query previous location', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}


// ---------------------------------------------------------------------------
// Place/region state machine.
//
// We track the user's current *semantic* location label — a known place
// (within 100m, e.g. "Home") or the geocoded city/town (e.g. "Be'erotaim") —
// persisted per user in a tiny ES doc (id = userId). Notifications fire only on
// a TRANSITION (the label changes), not on a distance threshold and not on
// every GPS push. This replaces the old >200m distance heuristic, which both
// missed "you're home" (no clean >200m hop) and spammed a duplicate notable
// event on every in-place jitter push.
// ---------------------------------------------------------------------------
const LOCATION_STATE_INDEX = 'll5_awareness_location_state';
// Anti-flap: don't re-push the same label within this window (handles A→B→A
// oscillation at a boundary, and survives a quick out-and-back).
const TRANSITION_DEDUP_MS = 5 * 60 * 1000;

interface LocationState {
  user_id: string;
  label: string;
  kind: 'place' | 'city';
  place_id?: string;
  city?: string;
  lat: number;
  lon: number;
  last_seen?: string;
  last_push_label?: string;
  last_push_at?: number;
  updated_at?: string;
}

interface CurrentLabel {
  label: string;
  kind: 'place' | 'city';
  place_id?: string;
  city?: string;
}

/** The user's current semantic label: known place > city; null = in transit. */
export function deriveLabel(
  placeMatch: PlaceMatchResult | null,
  geocode: GeocodingResult | null,
): CurrentLabel | null {
  if (placeMatch) {
    return { label: placeMatch.place_name, kind: 'place', place_id: placeMatch.place_id, city: geocode?.city };
  }
  if (geocode?.city) {
    return { label: geocode.city, kind: 'city', city: geocode.city };
  }
  return null; // unknown / in transit — awareness only, no push
}

/** Friendly push body. "Home" → "You're home"; place → "You're at X"; city → "You're in X". */
export function phraseArrival(cur: CurrentLabel): string {
  if (cur.kind === 'place') {
    return cur.label.trim().toLowerCase() === 'home' ? "You're home" : `You're at ${cur.label}`;
  }
  return `You're in ${cur.label}`;
}

async function getLocationState(es: Client, userId: string): Promise<LocationState | null> {
  try {
    const got = await es.get<LocationState>({ index: LOCATION_STATE_INDEX, id: userId });
    return got._source ?? null;
  } catch {
    return null; // no state yet (or index not created) — first push is a transition
  }
}

async function setLocationState(es: Client, userId: string, state: Omit<LocationState, 'user_id' | 'updated_at'>): Promise<void> {
  await es.index({
    index: LOCATION_STATE_INDEX,
    id: userId,
    document: { user_id: userId, ...state, updated_at: new Date().toISOString() },
    refresh: false,
  });
}

/**
 * Detect a place/region transition and notify the user.
 * Awaited (not fire-and-forget) so the per-user state read/write is serialized
 * against the location push that triggered it. On a transition we: write a
 * notable event (awareness), insert a system message (agent context, no FCM),
 * and send a direct FCM push ("You're home") at `notify` level.
 */
async function detectPlaceTransitionAndNotify(
  es: Client,
  pool: Pool,
  userId: string,
  item: PushLocationItem,
  geocode: GeocodingResult | null,
  placeMatch: PlaceMatchResult | null,
): Promise<void> {
  try {
    const cur = deriveLabel(placeMatch, geocode);
    const state = await getLocationState(es, userId);

    // In transit / unknown: keep the last confirmed label so the next known
    // place/city still reads as a transition. No event, no push.
    if (!cur) return;

    // Same place as last confirmed: just refresh coordinates/last_seen.
    if (state && state.label === cur.label) {
      await setLocationState(es, userId, {
        ...state, label: cur.label, kind: cur.kind, place_id: cur.place_id, city: cur.city,
        lat: item.lat, lon: item.lon, last_seen: item.timestamp,
      });
      return;
    }

    const now = Date.now();
    const prevLabel = state?.label;

    // Anti-flap: if we already pushed this exact label very recently (A→B→A),
    // update state silently without re-pushing.
    if (state?.last_push_label === cur.label && state.last_push_at && now - state.last_push_at < TRANSITION_DEDUP_MS) {
      await setLocationState(es, userId, {
        ...state, label: cur.label, kind: cur.kind, place_id: cur.place_id, city: cur.city,
        lat: item.lat, lon: item.lon, last_seen: item.timestamp,
      });
      return;
    }

    const summary = cur.kind === 'place' ? `Arrived at ${cur.label}` : `Now in ${cur.label}`;

    // 1) Awareness record
    await writeNotableEvent(es, userId, {
      event_type: 'location_change',
      timestamp: item.timestamp,
      summary,
      severity: 'low',
      payload: {
        kind: cur.kind,
        place_id: cur.place_id,
        place_name: cur.kind === 'place' ? cur.label : undefined,
        city: cur.city,
        previous: prevLabel,
        location: { lat: item.lat, lon: item.lon },
      },
    });

    // 2) Agent context (no FCM — the gateway sends the user push directly below)
    const ctx = prevLabel ? ` (was ${prevLabel})` : '';
    await insertSystemMessage(pool, userId, `[Location] ${phraseArrival(cur)}${ctx}.`);

    // 3) Direct push to the user
    await sendFCMNotification(pool, userId, {
      title: 'LL5',
      body: phraseArrival(cur),
      type: 'location',
      notification_level: 'notify',
    });

    // 4) Commit new state
    await setLocationState(es, userId, {
      label: cur.label, kind: cur.kind, place_id: cur.place_id, city: cur.city,
      lat: item.lat, lon: item.lon, last_seen: item.timestamp,
      last_push_label: cur.label, last_push_at: now,
    });

    logger.info('[location][transition] place/region transition pushed', { from: prevLabel ?? '(none)', to: cur.label, kind: cur.kind });
  } catch (err) {
    logger.warn('[location][transition] transition detection failed (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Process a location push item:
 * 1. Reverse geocode lat/lon to address
 * 2. Match against known places
 * 3. Write to ll5_awareness_locations
 * 4. If place matched, write notable event
 * 5. Detect movement and push system notification (non-blocking)
 */
export async function processLocation(
  es: Client,
  userId: string,
  item: PushLocationItem,
  geocodingApiKey?: string,
  pgPool?: Pool,
): Promise<void> {
  // Filter out low-accuracy GPS points (e.g. indoor drift, cell tower fallback)
  const MIN_ACCURACY_METERS = 100;
  if (item.accuracy_m != null && item.accuracy_m > MIN_ACCURACY_METERS) {
    logger.debug('[processLocation][handle] Skipping low-accuracy GPS point', {
      accuracy_m: item.accuracy_m,
      threshold: MIN_ACCURACY_METERS,
      lat: item.lat,
      lon: item.lon,
    });
    return;
  }

  // Filter out GPS drift: if the previous point was at a known place and
  // less than 10 minutes ago, and the new point is >500m away but speed
  // would require >150km/h, it's likely a GPS glitch.
  try {
    const prev = await getPreviousLocation(es, userId);
    if (prev?.location && prev.timestamp) {
      const distKm = haversine(prev.location, { lat: item.lat, lon: item.lon });
      const timeDiffMs = new Date(item.timestamp).getTime() - new Date(prev.timestamp).getTime();
      const timeDiffMin = timeDiffMs / 60000;

      // Only check for drift within a 10-minute window
      if (timeDiffMin > 0 && timeDiffMin < 10) {
        const speedKmh = distKm / (timeDiffMs / 3600000);

        // Case 1: Physically impossible speed (>150 km/h in city)
        if (speedKmh > 150) {
          logger.info('[processLocation][handle] Skipping implausible GPS jump', {
            distKm: Math.round(distKm * 10) / 10,
            timeDiffMin: Math.round(timeDiffMin),
            speedKmh: Math.round(speedKmh),
          });
          return;
        }

        // Case 2: Previous was at a known place, new point is >500m away
        // but within 5 min — likely drift from a stationary position
        if (prev.matched_place && distKm > 0.5 && timeDiffMin < 5) {
          logger.info('[processLocation][handle] Skipping likely drift from known place', {
            place: prev.matched_place,
            distKm: Math.round(distKm * 10) / 10,
            timeDiffMin: Math.round(timeDiffMin),
          });
          return;
        }
      }
    }
  } catch {
    // Non-critical — continue processing if plausibility check fails
  }

  // Run geocoding and place matching concurrently (both non-blocking)
  const [geocodeResult, placeMatch] = await Promise.all([
    reverseGeocode(item.lat, item.lon, geocodingApiKey),
    matchKnownPlace(es, userId, item.lat, item.lon),
  ]);

  // Detect a place/region transition and notify (awaited — serializes the
  // per-user state read/write against this push). Uses its own state doc, so
  // it's independent of the location-doc write below.
  if (pgPool) {
    await detectPlaceTransitionAndNotify(es, pgPool, userId, item, geocodeResult, placeMatch);
  }

  // Build the location document
  const doc: Record<string, unknown> = {
    user_id: userId,
    location: { lat: item.lat, lon: item.lon },
    timestamp: item.timestamp,
  };

  if (item.accuracy_m !== undefined) {
    doc.accuracy = item.accuracy_m;
  }

  if (item.battery_pct !== undefined) {
    doc.battery_pct = item.battery_pct;
  }

  if (geocodeResult) {
    doc.address = geocodeResult.address;
    if (geocodeResult.city) doc.city = geocodeResult.city;
    if (geocodeResult.neighborhood) doc.neighborhood = geocodeResult.neighborhood;
  }

  if (placeMatch) {
    doc.matched_place_id = placeMatch.place_id;
    doc.matched_place = placeMatch.place_name;
  }

  // Write location document
  await es.index({
    index: 'll5_awareness_locations',
    id: crypto.randomUUID(),
    document: doc,
    refresh: false,
  });

  logger.debug('[location][processLocation] Location stored', {
    lat: item.lat,
    lon: item.lon,
    address: geocodeResult?.address,
    matched_place: placeMatch?.place_name,
  });

  // Note: arrival notable events are written by detectPlaceTransitionAndNotify
  // (only on a real place/region transition), not on every in-place GPS push.
}
