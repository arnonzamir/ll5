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
import { gatewayKeyMutex } from '../utils/key-mutex.js';

/**
 * A point as stored, threaded as the in-batch predecessor for the next item's
 * drift check (G1/G2). Returned by processLocation; null means the point was
 * dropped/skipped and should NOT seed the next comparison.
 */
export interface StoredPoint {
  lat: number;
  lon: number;
  timestamp: string;
  matched_place?: string;
}

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
  // Serialize the per-user state read-modify-write (G5): concurrent webhooks for
  // the same user must not interleave a read with another's write, or we'd
  // double-fire the transition push / clobber last_push_at.
  try {
    await gatewayKeyMutex.runExclusive(`location-state:${userId}`, async () => {
      await runTransition(es, pool, userId, item, geocode, placeMatch);
    });
  } catch (err) {
    logger.warn('[location][transition] transition detection failed (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runTransition(
  es: Client,
  pool: Pool,
  userId: string,
  item: PushLocationItem,
  geocode: GeocodingResult | null,
  placeMatch: PlaceMatchResult | null,
): Promise<void> {
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
      logger.debug('[location][transition] deduped recent label, no re-push', {
        label: cur.label,
        sinceLastPushMs: now - state.last_push_at,
      });
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

    // 2) Agent context (no FCM — the gateway sends the user push directly below).
    // A4: tag signal quality so the agent knows confidence. A known-place match
    // (within 100m of a saved place) is high confidence; a geocoded city label
    // is coarse (anywhere in town), so flag it as lower confidence.
    const ctx = prevLabel ? ` (was ${prevLabel})` : '';
    const quality = cur.kind === 'place' ? ' [place match]' : ' [city-level]';
    await insertSystemMessage(pool, userId, `[Location] ${phraseArrival(cur)}${ctx}.${quality}`);

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
}

// ---------------------------------------------------------------------------
// Accuracy / plausibility constants. Named + commented so the rationale is
// explicit and tunable.
// ---------------------------------------------------------------------------

// Above this, a fix is "low accuracy" (indoor drift, cell-tower fallback). G9:
// rather than dropping it (which left dense-urban/indoor with NO location at
// all), we STILL store it flagged `low_accuracy: true` so downstream fusion can
// down-weight it.
const LOW_ACCURACY_METERS = 100;
// Above this, the fix is garbage (km-scale cell-sector estimate) — drop it.
const MAX_ACCURACY_METERS = 2000;

// Drift/speed window: only compare against a predecessor seen this recently.
const DRIFT_WINDOW_MIN = 10;
// Speed (km/h) that's implausible for short city hops; used together with
// device speed to distinguish real fast travel from teleport jitter.
const IMPLAUSIBLE_SPEED_KMH = 150;
// Absolute physical ceiling — beyond this NOTHING is real travel (faster than a
// jetliner), so drop regardless of what the device claims.
const ABSOLUTE_MAX_SPEED_KMH = 1000;
// Device speed (km/h) at/below which we consider the device "not really moving"
// for teleport-jitter detection.
const DEVICE_STATIONARY_SPEED_KMH = 30;
// How closely computed and device speed must agree (ratio) to call it confirmed
// real travel. 0.5 = within a factor of 2 either way — generous, since GPS fixes
// are noisy and a single hop's computed speed is coarse.
const SPEED_AGREEMENT_RATIO = 0.5;
// Drift-from-known-place guard: a >500m hop within 5 min of being AT a known
// place is almost always stationary jitter.
const KNOWN_PLACE_DRIFT_KM = 0.5;
const KNOWN_PLACE_DRIFT_MIN = 5;

/**
 * Process a location push item:
 * 1. Plausibility / drift filtering (drops glitches, flags low-accuracy)
 * 2. Reverse geocode lat/lon to address
 * 3. Match against known places
 * 4. Detect a place/region transition and notify
 * 5. Write to ll5_awareness_locations
 *
 * G1/G2: pass `prevPoint` (the chronological predecessor within THIS webhook
 * batch) so the drift check compares against the real previous point, not the
 * stale ES "latest". For the first location item in a batch, pass null and we
 * fall back to the ES latest. Returns the point we stored (so the caller can
 * chain it as the next item's `prevPoint`), or null if we dropped the point.
 */
export async function processLocation(
  es: Client,
  userId: string,
  item: PushLocationItem,
  geocodingApiKey?: string,
  pgPool?: Pool,
  prevPoint?: StoredPoint | null,
): Promise<StoredPoint | null> {
  // G9: accuracy gating. Garbage (> MAX) is dropped; merely low (> LOW) is kept
  // but flagged. We compute the flag here and let the point flow through.
  let lowAccuracy = false;
  if (item.accuracy_m != null && item.accuracy_m > MAX_ACCURACY_METERS) {
    logger.debug('[location][processLocation] dropping garbage-accuracy GPS point', {
      accuracy_m: item.accuracy_m,
      ceiling: MAX_ACCURACY_METERS,
      lat: item.lat,
      lon: item.lon,
    });
    return null;
  }
  if (item.accuracy_m != null && item.accuracy_m > LOW_ACCURACY_METERS) {
    lowAccuracy = true;
    logger.debug('[location][processLocation] low-accuracy GPS point kept (flagged)', {
      accuracy_m: item.accuracy_m,
      threshold: LOW_ACCURACY_METERS,
      lat: item.lat,
      lon: item.lon,
    });
  }

  // Device-reported speed (G3): convert m/s → km/h once for the checks below.
  const deviceSpeedKmh = item.speed_mps != null ? item.speed_mps * 3.6 : null;

  // ---- Drift / teleport filtering (G1/G2/G6) -----------------------------
  // Compare against the in-batch predecessor when provided; otherwise the ES
  // latest. A dropped GLITCH returns null (not stored). A low-accuracy point
  // that's otherwise plausible is NOT dropped here.
  try {
    let prev: { location: { lat: number; lon: number }; timestamp?: string; matched_place?: string } | null = null;
    if (prevPoint) {
      prev = { location: { lat: prevPoint.lat, lon: prevPoint.lon }, timestamp: prevPoint.timestamp, matched_place: prevPoint.matched_place };
    } else {
      const esPrev = await getPreviousLocation(es, userId);
      if (esPrev?.location) {
        prev = { location: esPrev.location, timestamp: esPrev.timestamp, matched_place: esPrev.matched_place };
      }
    }

    if (prev?.location && prev.timestamp) {
      const distKm = haversine(prev.location, { lat: item.lat, lon: item.lon });
      const timeDiffMs = new Date(item.timestamp).getTime() - new Date(prev.timestamp).getTime();
      const timeDiffMin = timeDiffMs / 60000;

      // timeDiff <= 0: still out-of-order after the sort, or clock skew. Skip
      // the speed math (it'd divide by zero / go negative) but DON'T bypass
      // storage — process the point normally below.
      if (timeDiffMin > 0 && timeDiffMin < DRIFT_WINDOW_MIN) {
        const computedSpeedKmh = distKm / (timeDiffMs / 3600000);

        // Absolute ceiling: physically impossible, always a glitch.
        if (computedSpeedKmh > ABSOLUTE_MAX_SPEED_KMH) {
          logger.info('[location][processLocation] dropping glitch: speed over absolute ceiling', {
            computedSpeedKmh: Math.round(computedSpeedKmh),
            deviceSpeedKmh: deviceSpeedKmh != null ? Math.round(deviceSpeedKmh) : null,
            distKm: Math.round(distKm * 10) / 10,
            timeDiffMin: Math.round(timeDiffMin * 10) / 10,
          });
          return null;
        }

        if (computedSpeedKmh > IMPLAUSIBLE_SPEED_KMH) {
          // G6: don't blindly drop fast travel. If the DEVICE also reports fast
          // motion that agrees with the computed speed, it's real highway/train/
          // flight — keep it. Only treat as a teleport glitch when the device is
          // (near-)stationary or gives no speed at all.
          const deviceConfirmsTravel =
            deviceSpeedKmh != null &&
            deviceSpeedKmh > DEVICE_STATIONARY_SPEED_KMH &&
            deviceSpeedKmh >= computedSpeedKmh * SPEED_AGREEMENT_RATIO;

          if (deviceConfirmsTravel) {
            logger.info('[location][processLocation] fast travel confirmed by device speed, keeping', {
              computedSpeedKmh: Math.round(computedSpeedKmh),
              deviceSpeedKmh: Math.round(deviceSpeedKmh),
              distKm: Math.round(distKm * 10) / 10,
            });
          } else {
            logger.info('[location][processLocation] dropping glitch: implausible jump, device speed low/absent', {
              computedSpeedKmh: Math.round(computedSpeedKmh),
              deviceSpeedKmh: deviceSpeedKmh != null ? Math.round(deviceSpeedKmh) : null,
              distKm: Math.round(distKm * 10) / 10,
              timeDiffMin: Math.round(timeDiffMin * 10) / 10,
            });
            return null;
          }
        }

        // Drift from a known place: a big hop right after being AT a place is
        // jitter — UNLESS the device confirms real motion.
        if (
          prev.matched_place &&
          distKm > KNOWN_PLACE_DRIFT_KM &&
          timeDiffMin < KNOWN_PLACE_DRIFT_MIN &&
          !(deviceSpeedKmh != null && deviceSpeedKmh > DEVICE_STATIONARY_SPEED_KMH)
        ) {
          logger.info('[location][processLocation] dropping glitch: drift from known place', {
            place: prev.matched_place,
            distKm: Math.round(distKm * 10) / 10,
            timeDiffMin: Math.round(timeDiffMin * 10) / 10,
          });
          return null;
        }
      } else if (timeDiffMin <= 0) {
        logger.debug('[location][processLocation] non-positive time delta, skipping speed check', {
          timeDiffMin: Math.round(timeDiffMin * 100) / 100,
        });
      }
    }
  } catch (err) {
    // Non-critical — continue processing if the plausibility check itself fails.
    logger.debug('[location][processLocation] plausibility check errored (continuing)', {
      error: err instanceof Error ? err.message : String(err),
    });
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

  if (lowAccuracy) {
    doc.low_accuracy = true;
  }

  // G3: persist device-reported motion when present.
  if (item.speed_mps !== undefined) {
    doc.speed = item.speed_mps;
  }
  if (item.bearing_deg !== undefined) {
    doc.bearing = item.bearing_deg;
  }
  if (item.altitude_m !== undefined) {
    doc.altitude = item.altitude_m;
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
    low_accuracy: lowAccuracy,
    speed_mps: item.speed_mps,
  });

  // Note: arrival notable events are written by detectPlaceTransitionAndNotify
  // (only on a real place/region transition), not on every in-place GPS push.

  // Return the stored point so the caller can chain it as the next item's
  // in-batch predecessor (G1/G2).
  return {
    lat: item.lat,
    lon: item.lon,
    timestamp: item.timestamp,
    matched_place: placeMatch?.place_name,
  };
}
