import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushLocationItem } from '../types/index.js';
import { reverseGeocode } from '../utils/geocoding.js';
import type { GeocodingResult } from '../utils/geocoding.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import { writeNotableEvent } from './notable.js';
import { gatewayKeyMutex } from '../utils/key-mutex.js';
import {
  resolveLocation,
  gateAccuracy,
  detectDriftGlitch,
  haversineMeters,
  timezoneFromLocation,
  DEFAULT_PLACE_RADIUS_M,
  TRANSITION_DEDUP_MS,
  TRIP_PULSE_MS,
  WIFI_CONNECTED_ANCHOR_MS,
  BSSID_MIN_OBSERVATIONS,
  type WifiSignal,
  type PriorLabel,
  type Motion,
} from '@ll5/shared';

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
    geo?: { lat: number; lon: number };
    radius_m?: number;
  };
}

// Candidate search cap — covers the largest configurable per-place radius (the
// upsert tool caps radius_m at 2000m). We then post-filter by each place's own
// radius (default DEFAULT_PLACE_RADIUS_M).
const PLACE_CANDIDATE_CAP_M = 2000;
// A hop larger than this from the previous fix, while the device reports it
// isn't moving, is treated as a GPS-jamming spoof (suspect), not real travel.
const SUSPECT_JUMP_KM = 20;

export interface PlaceMatchResult {
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
 * Query ll5_knowledge_places for a known place within 100m of the given coordinates.
 */
export async function matchKnownPlace(
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
            { geo_distance: { distance: `${PLACE_CANDIDATE_CAP_M}m`, geo: { lat, lon } } },
          ],
        },
      },
      sort: [{ _geo_distance: { geo: { lat, lon }, order: 'asc', unit: 'm' } }],
      size: 10,
    });

    // Return the NEAREST place whose own radius (per-place radius_m, default
    // DEFAULT_PLACE_RADIUS_M) actually contains the point.
    const hits = response.hits.hits as PlaceHit[];
    for (const hit of hits) {
      const src = hit._source;
      if (!hit._id || !src?.name || !src.geo) continue;
      const radius = typeof src.radius_m === 'number' && src.radius_m > 0 ? src.radius_m : DEFAULT_PLACE_RADIUS_M;
      const dist = haversineMeters({ lat, lon }, { lat: src.geo.lat, lon: src.geo.lon });
      if (dist <= radius) {
        return { place_id: hit._id, place_name: src.name };
      }
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


interface NetworkDoc {
  user_id?: string;
  manual_place_id?: string;
  manual_place_name?: string;
  place_observations?: Array<{ place_id: string; place_name: string; count: number }>;
}

/**
 * Build the latest-wifi signal for the resolver: the most recent wifi event plus
 * its BSSID→place binding (manual, or a learned place with >= BSSID_MIN_OBSERVATIONS
 * observations). Resilient — any failure yields `undefined` so a wifi hiccup never
 * blocks a location push. This is what lets the transition path anchor to a place
 * by wifi and stop home GPS-jitter flapping.
 */
async function getWifiSignal(es: Client, userId: string): Promise<WifiSignal | undefined> {
  try {
    const res = await es.search({
      index: 'll5_awareness_wifi_connections',
      query: { bool: { filter: [{ term: { user_id: userId } }] } },
      sort: [{ timestamp: { order: 'desc' } }],
      size: 1,
    });
    const hit = res.hits.hits[0]?._source as
      | { bssid?: string; ssid?: string; connected?: boolean; timestamp?: string }
      | undefined;
    if (!hit?.timestamp) return undefined;

    const ageMs = Date.now() - new Date(hit.timestamp).getTime();
    let bssidPlace: WifiSignal['bssidPlace'] = null;
    // Resolve within the (generous) connected-anchor window so the resolver has
    // the place to anchor on even when heartbeats are sparse.
    if (hit.bssid && ageMs < WIFI_CONNECTED_ANCHOR_MS) {
      bssidPlace = await resolveBssidPlace(es, userId, hit.bssid);
    }
    return {
      bssid: hit.bssid ?? null,
      ssid: hit.ssid ?? null,
      connected: hit.connected === true,
      ageMs,
      bssidPlace,
    };
  } catch (err) {
    logger.debug('[location][getWifiSignal] failed (continuing without wifi)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Resolve a BSSID to a confident known place (manual binding or >= N observations). */
async function resolveBssidPlace(
  es: Client,
  userId: string,
  bssid: string,
): Promise<WifiSignal['bssidPlace']> {
  try {
    const got = await es.get<NetworkDoc>({ index: 'll5_knowledge_networks', id: `${userId}::${bssid}` });
    const src = got._source;
    if (!src || src.user_id !== userId) return null;
    if (src.manual_place_id && src.manual_place_name) {
      return { placeId: src.manual_place_id, placeName: src.manual_place_name, confident: true };
    }
    if (src.place_observations && src.place_observations.length > 0) {
      const dominant = [...src.place_observations].sort((a, b) => b.count - a.count)[0];
      if (dominant.count >= BSSID_MIN_OBSERVATIONS) {
        return { placeId: dominant.place_id, placeName: dominant.place_name, confident: true };
      }
    }
    return null;
  } catch (err: unknown) {
    const e = err as { meta?: { statusCode?: number } };
    if (e.meta?.statusCode === 404) return null;
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
// TRANSITION_DEDUP_MS (anti-flap window) now lives in @ll5/shared.

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
  /** Last classified motion — lets us detect a driving→stopped "stop". */
  last_motion?: Motion;
  /** When we last emitted a trip pulse (epoch ms) — caps drive-time chatter. */
  last_pulse_at?: number;
  updated_at?: string;
}

/** Sentence-case a description ("driving on…" → "Driving on…") for a push body. */
function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

interface CurrentLabel {
  label: string;
  kind: 'place' | 'city';
  place_id?: string;
  city?: string;
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
  wifiSignal: WifiSignal | undefined,
): Promise<void> {
  // Serialize the per-user state read-modify-write (G5): concurrent webhooks for
  // the same user must not interleave a read with another's write, or we'd
  // double-fire the transition push / clobber last_push_at.
  try {
    await gatewayKeyMutex.runExclusive(`location-state:${userId}`, async () => {
      await runTransition(es, pool, userId, item, geocode, placeMatch, wifiSignal);
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
  wifiSignal: WifiSignal | undefined,
): Promise<void> {
    const state = await getLocationState(es, userId);

    // Resolve the current label through the SHARED resolver — wifi-anchored +
    // departure hysteresis, and now the USEFUL description ("driving on Route 6,
    // heading south — near Hadera" / "near Masada St, Haifa") + motion. The push
    // is "now", so GPS age is 0 (fresh); we pass accuracy (a low-accuracy edge fix
    // can't release a held place), the road/neighbourhood/bearing/speed that make
    // the description useful, and the prior committed label (anti-flap).
    const prior: PriorLabel | null = state
      ? { label: state.label, kind: state.kind, placeId: state.place_id }
      : null;
    const resolved = resolveLocation({
      gps: {
        lat: item.lat,
        lon: item.lon,
        accuracyM: item.accuracy_m,
        ageMs: 0,
        matchedPlace: placeMatch
          ? { placeId: placeMatch.place_id, placeName: placeMatch.place_name }
          : null,
        city: geocode?.city ?? null,
        road: geocode?.road ?? null,
        neighborhood: geocode?.neighborhood ?? null,
        bearingDeg: item.bearing_deg ?? null,
        // The Android app currently sends `speed` (m/s); the canonical field is
        // `speed_mps`. Accept either so motion classification works either way.
        speedMps: item.speed_mps ?? item.speed ?? null,
      },
      wifi: wifiSignal,
      prior,
    });

    // In transit / unknown: keep the last confirmed label so the next known
    // place/city still reads as a transition. No event, no push.
    if (!resolved.label || !resolved.labelKind) return;
    const cur: CurrentLabel = {
      label: resolved.label,
      kind: resolved.labelKind,
      place_id: resolved.placeId ?? undefined,
      city: geocode?.city,
    };
    const { description, motion } = resolved;

    const now = Date.now();
    const prevLabel = state?.label;
    const isPlace = cur.kind === 'place';
    const labelChanged = !state || state.label !== cur.label;
    const stoppedNow = state?.last_motion === 'driving' && motion !== 'driving';

    // ---- Notification policy: "stops + pulse, prefer more on less" -----------
    //  - place arrival (label changed to a known place) → push (a "stop").
    //  - driving → SUPPRESS per-town city spam; emit one rich "trip pulse" at
    //    most every TRIP_PULSE_MS so a long drive reads as periodic useful
    //    updates, not a town-by-town firehose.
    //  - stationary / walking → push when the label changes OR you just stopped
    //    (arriving / settling somewhere new), using the rich description.
    let pushBody: string | null = null;
    let isPulse = false;
    let summary: string;

    if (isPlace && labelChanged) {
      pushBody = phraseArrival(cur);
      summary = `Arrived at ${cur.label}`;
    } else if (motion === 'driving') {
      summary = capitalize(description);
      if (now - (state?.last_pulse_at ?? 0) >= TRIP_PULSE_MS) {
        pushBody = capitalize(description);
        isPulse = true;
      }
    } else if (!isPlace && (labelChanged || stoppedNow)) {
      pushBody = capitalize(description);
      summary = capitalize(description);
    } else {
      summary = capitalize(description);
    }

    // Anti-flap: never re-push the exact same STOP label within the dedup window
    // (A→B→A bounce). Pulses are already timer-gated, so they're exempt.
    if (
      pushBody && !isPulse &&
      state?.last_push_label === cur.label && state.last_push_at &&
      now - state.last_push_at < TRANSITION_DEDUP_MS
    ) {
      logger.debug('[location][transition] deduped recent label, no re-push', {
        label: cur.label, sinceLastPushMs: now - state.last_push_at,
      });
      pushBody = null;
    }

    // State advances every point so motion/label/coords stay current even when we
    // stay silent; last_push_* / last_pulse_at only move when we actually surface.
    const nextState: Omit<LocationState, 'user_id' | 'updated_at'> = {
      label: cur.label, kind: cur.kind, place_id: cur.place_id, city: cur.city,
      lat: item.lat, lon: item.lon, last_seen: item.timestamp,
      last_motion: motion,
      last_push_label: pushBody ? cur.label : state?.last_push_label,
      last_push_at: pushBody ? now : state?.last_push_at,
      last_pulse_at: isPulse ? now : state?.last_pulse_at,
    };

    if (!pushBody) {
      await setLocationState(es, userId, nextState);
      return;
    }

    // 1) Awareness record (carries the rich description + motion for history).
    await writeNotableEvent(es, userId, {
      event_type: 'location_change',
      timestamp: item.timestamp,
      summary,
      severity: 'low',
      payload: {
        kind: cur.kind,
        place_id: cur.place_id,
        place_name: isPlace ? cur.label : undefined,
        city: cur.city,
        motion,
        description,
        pulse: isPulse,
        previous: prevLabel,
        location: { lat: item.lat, lon: item.lon },
      },
    });

    // 2) Wake the agent with a CLEARLY-LABELED location event. The agent — not the
    // gateway — now owns the decision of whether to notify the user and how to word
    // it (see the agent prompt's Location Intelligence section). We hand it the event
    // kind (arrived / left / stopped / en route), the rich description, and the motion
    // so it can recognize arrivals & departures and name the travel mode itself.
    const wasPlace = state?.kind === 'place';
    let eventKind: string;
    if (isPlace && labelChanged) eventKind = `Arrived at ${cur.label}`;
    else if (wasPlace && labelChanged && !isPlace) eventKind = `Left ${prevLabel}`;
    else if (stoppedNow) eventKind = 'Stopped';
    else if (isPulse) eventKind = 'En route';
    else eventKind = 'Update';
    const agentText = isPlace ? phraseArrival(cur) : description;
    const quality = isPlace ? '[place match]' : '[city-level]';
    await insertSystemMessage(
      pool, userId,
      `[Location] ${eventKind} — ${agentText}. motion=${motion}. ${quality}`,
    );

    // 3) Commit new state
    await setLocationState(es, userId, nextState);

    logger.info('[location][transition] location update pushed', {
      from: prevLabel ?? '(none)', to: cur.label, kind: cur.kind, motion, pulse: isPulse,
    });
}

// Accuracy / plausibility / drift thresholds now live in @ll5/shared
// (LOW_ACCURACY_METERS, MAX_ACCURACY_METERS, speed limits, KNOWN_PLACE_DRIFT_*),
// applied via the shared gateAccuracy() + detectDriftGlitch() helpers below.

/**
 * Derive the IANA timezone of a FRESH, NON-SUSPECT GPS fix and cache it on the
 * user as `current_timezone` (+ `current_timezone_at`). This is the *producer*
 * of the effective-timezone signal that the schedulers and FCM quiet-hours
 * consume. Only persists when the derived zone actually CHANGES from the stored
 * one (avoids a JSONB write on every push). Best-effort — a failure here never
 * blocks location processing.
 */
async function updateCurrentTimezoneFromLocation(
  pool: Pool,
  userId: string,
  lat: number,
  lon: number,
): Promise<void> {
  const zone = timezoneFromLocation(lat, lon);
  if (!zone) return;
  try {
    const result = await pool.query<{ current_tz: string | null }>(
      "SELECT settings->>'current_timezone' AS current_tz FROM user_settings WHERE user_id = $1",
      [userId],
    );
    const stored = result.rows[0]?.current_tz ?? null;
    if (stored === zone) return; // unchanged — no write

    const nowIso = new Date().toISOString();
    await pool.query(
      `INSERT INTO user_settings (user_id, settings, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET
         settings = user_settings.settings || $2::jsonb,
         updated_at = now()`,
      [userId, JSON.stringify({ current_timezone: zone, current_timezone_at: nowIso })],
    );
    logger.info('[location][timezone] current_timezone updated from GPS', {
      userId,
      from: stored ?? '(none)',
      to: zone,
    });
  } catch (err) {
    logger.warn('[location][timezone] failed to update current_timezone (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
  // G9: accuracy gating via the shared helper — garbage (>MAX) dropped, low
  // (>LOW) kept but flagged so downstream down-weights it / never transitions off it.
  const acc = gateAccuracy(item.accuracy_m);
  if (acc.drop) {
    logger.debug('[location][processLocation] dropping garbage-accuracy GPS point', {
      accuracy_m: item.accuracy_m,
      lat: item.lat,
      lon: item.lon,
    });
    return null;
  }
  const lowAccuracy = acc.lowAccuracy;
  if (lowAccuracy) {
    logger.debug('[location][processLocation] low-accuracy GPS point kept (flagged)', {
      accuracy_m: item.accuracy_m,
      lat: item.lat,
      lon: item.lon,
    });
  }

  // Device-reported speed (G3): convert m/s → km/h for the drift check.
  // Accept the app's `speed` field as well as the canonical `speed_mps`.
  const deviceSpeedMps = item.speed_mps ?? item.speed;
  const deviceSpeedKmh = deviceSpeedMps != null ? deviceSpeedMps * 3.6 : null;

  // ---- Drift / teleport filtering (G1/G2/G6) via the shared helper ----------
  // Compare against the in-batch predecessor when provided; otherwise the ES
  // latest. A dropped GLITCH returns null (not stored).
  let prev: { lat: number; lon: number; timestampMs: number; atKnownPlace: boolean } | null = null;
  try {
    if (prevPoint) {
      prev = {
        lat: prevPoint.lat,
        lon: prevPoint.lon,
        timestampMs: new Date(prevPoint.timestamp).getTime(),
        atKnownPlace: !!prevPoint.matched_place,
      };
    } else {
      const esPrev = await getPreviousLocation(es, userId);
      if (esPrev?.location && esPrev.timestamp) {
        prev = {
          lat: esPrev.location.lat,
          lon: esPrev.location.lon,
          timestampMs: new Date(esPrev.timestamp).getTime(),
          atKnownPlace: !!esPrev.matched_place,
        };
      }
    }
    const verdict = detectDriftGlitch(
      prev,
      { lat: item.lat, lon: item.lon, timestampMs: new Date(item.timestamp).getTime() },
      deviceSpeedKmh,
    );
    if (verdict.drop) {
      logger.info(`[location][processLocation] dropping glitch: ${verdict.reason}`, {
        lat: item.lat,
        lon: item.lon,
      });
      return null;
    }
  } catch (err) {
    // Non-critical — continue processing if the plausibility check itself fails.
    logger.debug('[location][processLocation] plausibility check errored (continuing)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Run geocoding, place matching, and the latest-wifi fetch concurrently.
  const [geocodeResult, placeMatch, wifiSignal] = await Promise.all([
    reverseGeocode(item.lat, item.lon, geocodingApiKey),
    matchKnownPlace(es, userId, item.lat, item.lon),
    getWifiSignal(es, userId),
  ]);

  // ---- GPS-jamming / spoof guard (G10) --------------------------------------
  // Regional GPS jamming snaps the chip to a far airport (e.g. Amman/Beirut)
  // with a confident-looking accuracy, while you're actually home. Speed-based
  // drift misses it across an overnight gap (the implied speed looks plausible).
  // Two tells: (a) you're on a place-bound wifi but GPS isn't at that place;
  // (b) a large jump from the previous fix while the device reports it's not
  // moving (you can't be 20km away from where you just were, at rest). Flag —
  // don't drop — so the data survives for the map/review, but where_is_user and
  // the agent treat a `suspect` fix as NOT the user's location.
  let suspect = false;
  let suspectReason: string | undefined;
  const hopKm = prev
    ? haversineMeters({ lat: prev.lat, lon: prev.lon }, { lat: item.lat, lon: item.lon }) / 1000
    : 0;
  // Both rules require a LARGE hop (jitter-safe — normal GPS noise is metres).
  if (hopKm > SUSPECT_JUMP_KM) {
    const wifiAnchored = !!(wifiSignal?.connected && wifiSignal.bssidPlace?.confident);
    const gpsNotAtWifiPlace =
      !placeMatch ||
      (wifiSignal?.bssidPlace != null && placeMatch.place_id !== wifiSignal.bssidPlace.placeId);
    const reportedStationary = deviceSpeedKmh != null && deviceSpeedKmh < 5;
    if (wifiAnchored && gpsNotAtWifiPlace) {
      // Strongest tell: you're on a known place's wifi but GPS jumped far away.
      suspect = true;
      suspectReason = 'wifi_anchor_disagreement';
    } else if (reportedStationary) {
      // You can't be 20km from where you just were while not moving.
      suspect = true;
      suspectReason = 'teleport_while_stationary';
    }
  }
  if (suspect) {
    logger.info('[location][processLocation] GPS fix flagged suspect (likely jamming)', {
      reason: suspectReason,
      lat: item.lat,
      lon: item.lon,
      hop_km: Math.round(hopKm),
      wifi_place: wifiSignal?.bssidPlace?.placeName,
    });
  }

  // Detect a place/region transition and notify (awaited — serializes the
  // per-user state read/write against this push). Now WiFi-aware + hysteresis
  // via the shared resolver, so home GPS-jitter no longer flaps to city-level.
  // A suspect (jammed) fix must NOT drive a transition — skip the notifier.
  // Same gate guards the timezone producer: only a fresh, non-suspect, non-stale
  // (glitches/garbage already dropped above) fix derives a current zone, so we
  // never snap the user's effective tz to a jammed airport.
  if (pgPool && !suspect) {
    await updateCurrentTimezoneFromLocation(pgPool, userId, item.lat, item.lon);
    await detectPlaceTransitionAndNotify(es, pgPool, userId, item, geocodeResult, placeMatch, wifiSignal);
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
    if (geocodeResult.road) doc.road = geocodeResult.road;
    if (geocodeResult.neighborhood) doc.neighborhood = geocodeResult.neighborhood;
  }

  if (placeMatch) {
    doc.matched_place_id = placeMatch.place_id;
    doc.matched_place = placeMatch.place_name;
  }

  if (suspect) {
    doc.suspect = true;
    if (suspectReason) doc.suspect_reason = suspectReason;
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
