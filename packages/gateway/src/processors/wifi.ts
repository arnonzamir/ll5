import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushWifiItem } from '../types/index.js';
import { logger } from '../utils/logger.js';

const WIFI_INDEX = 'll5_awareness_wifi_connections';
const NETWORKS_INDEX = 'll5_knowledge_networks';
const LOCATIONS_INDEX = 'll5_awareness_locations';

const RECENT_GPS_WINDOW_MS = 5 * 60 * 1000; // GPS fix must be within 5 min of WiFi event to count as co-occurrence

interface RecentGpsHit {
  _source?: {
    timestamp?: string;
    matched_place_id?: string;
    matched_place?: string;
  };
}

interface NetworkDoc {
  user_id: string;
  bssid: string;
  ssid?: string;
  place_observations?: Array<{
    place_id: string;
    place_name: string;
    count: number;
    last_seen: string;
  }>;
  manual_place_id?: string;
  manual_place_name?: string;
  label?: string;
  total_observations: number;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
}

/**
 * Look up the most recent GPS fix for the user. Returns it only if it's
 * within RECENT_GPS_WINDOW_MS of the wifi event timestamp.
 */
async function getRecentGpsWithPlace(
  es: Client,
  userId: string,
  wifiTimestamp: string,
): Promise<{ place_id: string; place_name: string } | null> {
  try {
    const response = await es.search({
      index: LOCATIONS_INDEX,
      query: {
        bool: {
          filter: [{ term: { user_id: userId } }, { exists: { field: 'matched_place_id' } }],
        },
      },
      sort: [{ timestamp: { order: 'desc' } }],
      size: 1,
    });

    const hits = response.hits.hits as RecentGpsHit[];
    if (hits.length === 0 || !hits[0]._source) return null;

    const src = hits[0]._source;
    if (!src.timestamp || !src.matched_place_id || !src.matched_place) return null;

    const ageMs = Math.abs(new Date(wifiTimestamp).getTime() - new Date(src.timestamp).getTime());
    if (ageMs > RECENT_GPS_WINDOW_MS) return null;

    return { place_id: src.matched_place_id, place_name: src.matched_place };
  } catch (err) {
    logger.warn('[wifi][getRecentGpsWithPlace] Lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Auto-learning: upsert the (user_id, bssid) network doc with an observation
 * for the place co-occurring with this wifi event.
 *
 * Document id is deterministic: `${userId}::${bssid}` so we can use index-with-id
 * upserts without scripting (cleaner than update-by-query).
 */
async function upsertNetworkObservation(
  es: Client,
  userId: string,
  bssid: string,
  ssid: string | null,
  matchedPlace: { place_id: string; place_name: string } | null,
  timestamp: string,
): Promise<void> {
  const docId = `${userId}::${bssid}`;
  const now = new Date().toISOString();

  let existing: NetworkDoc | null = null;
  try {
    const got = await es.get<NetworkDoc>({ index: NETWORKS_INDEX, id: docId });
    existing = got._source ?? null;
  } catch (err: unknown) {
    const e = err as { meta?: { statusCode?: number } };
    if (e.meta?.statusCode !== 404) {
      logger.warn('[wifi][upsertNetworkObservation] Read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  const observations = existing?.place_observations ? [...existing.place_observations] : [];

  if (matchedPlace) {
    const idx = observations.findIndex((o) => o.place_id === matchedPlace.place_id);
    if (idx >= 0) {
      observations[idx] = {
        ...observations[idx],
        count: observations[idx].count + 1,
        last_seen: timestamp,
        place_name: matchedPlace.place_name, // refresh in case the place was renamed
      };
    } else {
      observations.push({
        place_id: matchedPlace.place_id,
        place_name: matchedPlace.place_name,
        count: 1,
        last_seen: timestamp,
      });
    }
  }

  const doc: NetworkDoc = {
    user_id: userId,
    bssid,
    ssid: ssid ?? existing?.ssid,
    place_observations: observations,
    manual_place_id: existing?.manual_place_id,
    manual_place_name: existing?.manual_place_name,
    label: existing?.label,
    total_observations: (existing?.total_observations ?? 0) + 1,
    first_seen: existing?.first_seen ?? timestamp,
    last_seen: timestamp,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  await es.index({
    index: NETWORKS_INDEX,
    id: docId,
    document: doc as unknown as Record<string, unknown>,
    refresh: false,
  });

  if (matchedPlace) {
    const obs = observations.find((o) => o.place_id === matchedPlace.place_id);
    logger.info('[wifi][upsertNetworkObservation] Auto-learned', {
      userId,
      bssid,
      ssid,
      place: matchedPlace.place_name,
      observations_at_place: obs?.count ?? 1,
      total_observations: doc.total_observations,
    });
  } else {
    logger.debug('[wifi][upsertNetworkObservation] Recorded unbound observation', {
      userId,
      bssid,
      total_observations: doc.total_observations,
    });
  }
}

export async function processWifi(
  es: Client,
  userId: string,
  item: PushWifiItem,
): Promise<void> {
  // Write the raw connection event
  const doc: Record<string, unknown> = {
    user_id: userId,
    connected: item.connected,
    timestamp: item.timestamp,
  };
  if (item.ssid !== undefined && item.ssid !== null) doc.ssid = item.ssid;
  if (item.bssid !== undefined && item.bssid !== null) doc.bssid = item.bssid;
  if (item.rssi_dbm !== undefined) doc.rssi_dbm = item.rssi_dbm;
  if (item.frequency_mhz !== undefined) doc.frequency_mhz = item.frequency_mhz;
  if (item.link_speed_mbps !== undefined) doc.link_speed_mbps = item.link_speed_mbps;
  if (item.ip_address !== undefined && item.ip_address !== null) doc.ip_address = item.ip_address;
  if (item.trigger !== undefined) doc.trigger = item.trigger;

  await es.index({
    index: WIFI_INDEX,
    id: crypto.randomUUID(),
    document: doc,
    refresh: false,
  });

  logger.info('[wifi][processWifi] Connection event stored', {
    userId,
    ssid: item.ssid,
    bssid: item.bssid,
    connected: item.connected,
    trigger: item.trigger,
  });

  // Auto-learning: only on connect events with a real BSSID
  if (!item.connected || !item.bssid) return;

  const matchedPlace = await getRecentGpsWithPlace(es, userId, item.timestamp);
  if (!matchedPlace) {
    logger.info('[wifi][processWifi] Auto-learn skipped: no recent GPS with matched place', {
      userId,
      bssid: item.bssid,
      ssid: item.ssid,
      window_minutes: RECENT_GPS_WINDOW_MS / 60_000,
    });
  }
  await upsertNetworkObservation(es, userId, item.bssid, item.ssid ?? null, matchedPlace, item.timestamp);
}
