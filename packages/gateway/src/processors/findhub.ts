import type { Client } from '@elastic/elasticsearch';
import type { PushTrackedDeviceItem } from '../types/index.js';
import { reverseGeocode } from '../utils/geocoding.js';
import { matchKnownPlace } from './location.js';
import { logger } from '../utils/logger.js';

const TRACKED_DEVICES_INDEX = 'll5_awareness_tracked_devices';

/**
 * Deterministic per-device doc id. One doc per physical device per user, so a
 * fresh fix UPSERTS over the previous one rather than appending. Embeds the
 * user_id (DECISION-006) so ids never collide across tenants.
 */
function trackedDeviceDocId(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/**
 * Process a tracked-device fix from the Google Find Hub network (pushed by the
 * findhub-poller sidecar).
 *
 * Unlike processLocation, this does NOT touch the user's GPS stream
 * (ll5_awareness_locations) and does NO drift/teleport filtering — the Find Hub
 * network returns a single crowd-sourced "last known" fix per device, not a
 * stream, so there's no predecessor to compare against and successive fixes can
 * legitimately jump (the device moved while we weren't looking).
 *
 * We reverse-geocode and place-match the fix (so "keys are at Home"), then
 * upsert the current-state doc keyed by device. v1 emits no notifications.
 */
export async function processTrackedDevice(
  es: Client,
  userId: string,
  item: PushTrackedDeviceItem,
  geocodingApiKey?: string,
): Promise<void> {
  // Geocode + place match concurrently (both best-effort, non-blocking).
  const [geocodeResult, placeMatch] = await Promise.all([
    reverseGeocode(item.lat, item.lon, geocodingApiKey),
    matchKnownPlace(es, userId, item.lat, item.lon),
  ]);

  const doc: Record<string, unknown> = {
    user_id: userId,
    device_id: item.device_id,
    name: item.name,
    device_type: item.device_type ?? 'unknown',
    location: { lat: item.lat, lon: item.lon },
    last_seen: item.timestamp,
    updated_at: new Date().toISOString(),
  };

  if (item.accuracy_m !== undefined) doc.accuracy = item.accuracy_m;
  if (item.battery_pct !== undefined) doc.battery_pct = item.battery_pct;
  if (item.semantic_name) doc.semantic_name = item.semantic_name;

  if (geocodeResult) {
    doc.address = geocodeResult.address;
  }
  if (placeMatch) {
    doc.matched_place_id = placeMatch.place_id;
    doc.matched_place = placeMatch.place_name;
  }

  // Upsert current-state by deterministic id — overwrites the prior fix.
  await es.index({
    index: TRACKED_DEVICES_INDEX,
    id: trackedDeviceDocId(userId, item.device_id),
    document: doc,
    refresh: false,
  });

  logger.debug('[findhub][processTrackedDevice] Tracked device updated', {
    device_id: item.device_id,
    name: item.name,
    type: doc.device_type,
    matched_place: placeMatch?.place_name,
    address: geocodeResult?.address,
    last_seen: item.timestamp,
  });
}
