import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import type { PushGeofenceTransitionItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import { writeNotableEvent } from './notable.js';
import { gatewayKeyMutex } from '../utils/key-mutex.js';
import {
  getLocationState,
  setLocationState,
  phraseArrival,
  type LocationState,
} from './location.js';

/**
 * Resolve a usable place label. The app sends `place_name` for known places, but
 * it's optional in the contract — fall back to the ES place doc's name, then to a
 * generic "this place" so we never wake with an empty label.
 */
async function resolvePlaceName(
  es: Client,
  userId: string,
  item: PushGeofenceTransitionItem,
): Promise<string> {
  if (item.place_name && item.place_name.trim()) return item.place_name.trim();
  try {
    const got = await es.get<{ user_id?: string; name?: string }>({
      index: 'll5_knowledge_places',
      id: item.place_id,
    });
    const src = got._source;
    if (src && src.user_id === userId && src.name) return src.name;
  } catch {
    // missing place doc — fall through to a generic label
  }
  return 'this place';
}

/**
 * Process a geofence transition from the phone's Play-Services geofencing.
 *
 * Geofences are built (GET /geofences) from the user's known places, so a
 * transition here is ALWAYS about a known place. We cooperate with the GPS-based
 * place state machine (processors/location.ts runTransition) by reading/writing
 * the SAME ll5_awareness_location_state doc via the shared
 * getLocationState/setLocationState helpers:
 *
 *  - `dwell` = a CONFIRMED arrival. The on-device 60s loiter already filtered
 *    drive-pasts, so this is authoritative. If we're not already recorded as at
 *    this place, we set the state to it (so the GPS path sees the place as current
 *    and won't double-fire its own "Arrived at X") and wake the agent. If we're
 *    already here (dedup), do nothing.
 *  - `exit` = a departure. If the state was at this place, clear it to "unknown"
 *    (a city-kind placeholder) and wake the agent. Otherwise just log.
 *  - `enter` = NOT notified. A drive-through fires enter→exit without ever
 *    dwelling, so waking on enter would ping on every pass. We wait for dwell.
 *
 * All wake text is tagged `[geofence]` so it's distinguishable from the GPS
 * path's `[place match]` / `[city-level]` quality tags.
 *
 * The whole read-modify-write runs under the SAME per-user mutex key the GPS
 * transition path uses (`location-state:<userId>`) so a geofence push and a
 * concurrent GPS push can't interleave their reads and writes of the state doc.
 */
export async function processGeofence(
  es: Client,
  userId: string,
  item: PushGeofenceTransitionItem,
  pgPool?: Pool,
): Promise<void> {
  const placeName = await resolvePlaceName(es, userId, item);

  // `enter` never notifies and never touches state — record a lightweight log only.
  if (item.transition === 'enter') {
    logger.debug('[geofence][processGeofence] enter (suppressed — waiting for dwell)', {
      userId,
      place_id: item.place_id,
      place: placeName,
    });
    return;
  }

  // dwell / exit both mutate the shared location-state doc — serialize against the
  // GPS transition path under the same per-user key.
  await gatewayKeyMutex.runExclusive(`location-state:${userId}`, async () => {
    const state = await getLocationState(es, userId);

    if (item.transition === 'dwell') {
      await handleDwell(es, userId, item, placeName, state, pgPool);
    } else {
      await handleExit(es, userId, item, placeName, state, pgPool);
    }
  });
}

/** dwell → authoritative "Arrived at <place>". */
async function handleDwell(
  es: Client,
  userId: string,
  item: PushGeofenceTransitionItem,
  placeName: string,
  state: LocationState | null,
  pgPool?: Pool,
): Promise<void> {
  // Already recorded as at this place (by place_id when known, else by label) —
  // a repeated dwell. Dedup: do nothing.
  const alreadyHere = state?.kind === 'place'
    && (
      (state.place_id && state.place_id === item.place_id) ||
      (!state.place_id && state.label === placeName)
    );
  if (alreadyHere) {
    logger.debug('[geofence][dwell] already at place — no double-fire', {
      userId,
      place_id: item.place_id,
      place: placeName,
    });
    return;
  }

  // Set the state to this place so the GPS runTransition path sees the place as
  // current and won't independently fire its own "Arrived at X". We keep the last
  // known coordinates when the geofence push carries none (lat/lon are optional).
  const lat = item.lat ?? state?.lat ?? 0;
  const lon = item.lon ?? state?.lon ?? 0;
  await setLocationState(es, userId, {
    label: placeName,
    kind: 'place',
    place_id: item.place_id,
    city: state?.city,
    lat,
    lon,
    last_seen: item.timestamp,
    // A geofence dwell is a surfaced "stop" — record it as the last push so the
    // GPS anti-flap window also sees this place as just-pushed.
    last_push_label: placeName,
    last_push_at: Date.now(),
    last_motion: 'stationary',
    last_pulse_at: state?.last_pulse_at,
  });

  await writeNotableEvent(es, userId, {
    event_type: 'location_change',
    timestamp: item.timestamp,
    summary: `Arrived at ${placeName}`,
    severity: 'low',
    payload: {
      kind: 'place',
      place_id: item.place_id,
      place_name: placeName,
      source: 'geofence',
      transition: 'dwell',
      ...(item.lat != null && item.lon != null ? { location: { lat: item.lat, lon: item.lon } } : {}),
    },
  });

  if (pgPool) {
    const arrival = phraseArrival({ label: placeName, kind: 'place', place_id: item.place_id });
    await insertSystemMessage(
      pgPool,
      userId,
      `[Location] Arrived at ${placeName} — ${arrival}. [geofence]`,
    );
  }

  logger.info('[geofence][dwell] arrival recorded', {
    userId,
    place_id: item.place_id,
    place: placeName,
    from: state?.label ?? '(none)',
  });
}

/** exit → "Left <place>" when the state was at this place; otherwise just log. */
async function handleExit(
  es: Client,
  userId: string,
  item: PushGeofenceTransitionItem,
  placeName: string,
  state: LocationState | null,
  pgPool?: Pool,
): Promise<void> {
  const wasHere = state?.kind === 'place'
    && (
      (state.place_id && state.place_id === item.place_id) ||
      (!state.place_id && state.label === placeName)
    );

  if (!wasHere) {
    // State wasn't at this place (the GPS path may already have moved us on, or we
    // never recorded the arrival) — don't clear someone else's state, just log.
    logger.debug('[geofence][exit] exit for a place we are not recorded at — logging only', {
      userId,
      place_id: item.place_id,
      place: placeName,
      current: state?.label ?? '(none)',
    });
    return;
  }

  // Clear the PLACE but keep the last-known city if we have one — leaving a place
  // doesn't leave its city, and "Unknown" is worse to read than the city the user
  // is still in. The next GPS fix re-resolves the precise location; staying on the
  // same city label there reads as no transition (correct — you only left the place).
  // Only fall back to "Unknown" when we never knew a city.
  const fallbackCity = state?.city;
  const exitLabel = fallbackCity ?? 'Unknown';
  const lat = item.lat ?? state?.lat ?? 0;
  const lon = item.lon ?? state?.lon ?? 0;
  await setLocationState(es, userId, {
    label: exitLabel,
    kind: 'city',
    place_id: undefined,
    city: fallbackCity,
    lat,
    lon,
    last_seen: item.timestamp,
    last_push_label: exitLabel,
    last_push_at: Date.now(),
    last_motion: state?.last_motion,
    last_pulse_at: state?.last_pulse_at,
  });

  await writeNotableEvent(es, userId, {
    event_type: 'location_change',
    timestamp: item.timestamp,
    summary: `Left ${placeName}`,
    severity: 'low',
    payload: {
      kind: 'city',
      previous: placeName,
      place_id: item.place_id,
      source: 'geofence',
      transition: 'exit',
      ...(item.lat != null && item.lon != null ? { location: { lat: item.lat, lon: item.lon } } : {}),
    },
  });

  if (pgPool) {
    await insertSystemMessage(
      pgPool,
      userId,
      `[Location] Left ${placeName} — on the move. [geofence]`,
    );
  }

  logger.info('[geofence][exit] departure recorded', {
    userId,
    place_id: item.place_id,
    place: placeName,
  });
}
