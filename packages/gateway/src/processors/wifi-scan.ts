import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushWifiScanItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { gatewayKeyMutex } from '../utils/key-mutex.js';
import { getLocationState } from './location.js';
import {
  SCAN_FRESH_MS,
  VISIBLE_MIN_RSSI_LEARN,
  VISIBLE_LEARN_CAP_PER_PLACE,
} from '@ll5/shared';

// G8 (same cap as processors/wifi.ts): bound place_observations per network doc.
const MAX_PLACE_OBSERVATIONS = 20;

const SCANS_INDEX = 'll5_awareness_wifi_scans';
const NETWORKS_INDEX = 'll5_knowledge_networks';

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
  /** DECISION-021: 'connected' | 'visible'. Absent on legacy docs = connected. */
  binding?: 'connected' | 'visible';
  label?: string;
  total_observations: number;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
}

/**
 * BSSIDs of network docs already carrying a `visible` binding with an
 * observation at this place — the set the VISIBLE_LEARN_CAP_PER_PLACE cap
 * counts. Fail-closed to "cap reached" is wrong (it would silently stop all
 * learning on an ES blip), so a query failure returns null and the caller
 * skips learning this scan with a warning.
 */
async function getVisibleBssidsForPlace(
  es: Client,
  userId: string,
  placeId: string,
): Promise<Set<string> | null> {
  try {
    const res = await es.search({
      index: NETWORKS_INDEX,
      query: {
        bool: {
          filter: [
            { term: { user_id: userId } },
            { term: { binding: 'visible' } },
            {
              nested: {
                path: 'place_observations',
                query: { term: { 'place_observations.place_id': placeId } },
              },
            },
          ],
        },
      },
      size: VISIBLE_LEARN_CAP_PER_PLACE * 3,
      _source: ['bssid'],
    });
    const bssids = new Set<string>();
    for (const hit of res.hits.hits) {
      const b = (hit._source as { bssid?: string } | undefined)?.bssid;
      if (b) bssids.add(b);
    }
    return bssids;
  } catch (err) {
    logger.warn('[wifi-scan][getVisibleBssidsForPlace] cap query failed — skipping learn', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Upsert one visible-network observation for the place the user is confidently
 * at. Mirrors processors/wifi.ts upsertNetworkObservation (G5 key-mutex, G8
 * observation cap, deterministic `${userId}::${bssid}` doc id), with the
 * DECISION-021 twist: docs CREATED by scan-learning get `binding: "visible"`;
 * docs that already exist keep their binding (a connected network seen in a
 * scan stays connected — scan sightings only add observation weight).
 *
 * Returns true when this bssid now counts as a visible binding at the place
 * (so the caller can advance the per-place cap set).
 */
async function upsertVisibleObservation(
  es: Client,
  userId: string,
  network: { bssid: string; ssid: string | null; rssi: number },
  place: { place_id: string; place_name: string },
  timestamp: string,
  capReached: boolean,
): Promise<boolean> {
  const docId = `${userId}::${network.bssid}`;
  let countsTowardCap = false;

  // G5: serialize the per-(user::bssid) read-modify-write.
  await gatewayKeyMutex.runExclusive(`network-obs:${docId}`, async () => {
    const now = new Date().toISOString();

    let existing: NetworkDoc | null = null;
    try {
      const got = await es.get<NetworkDoc>({ index: NETWORKS_INDEX, id: docId });
      existing = got._source ?? null;
    } catch (err: unknown) {
      const e = err as { meta?: { statusCode?: number } };
      if (e.meta?.statusCode !== 404) {
        logger.warn('[wifi-scan][upsertVisibleObservation] Read failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    const isVisibleDoc = existing ? existing.binding === 'visible' : true; // new docs are visible
    const observations = existing?.place_observations ? [...existing.place_observations] : [];
    const idx = observations.findIndex((o) => o.place_id === place.place_id);

    // Cap gate: only a NEW visible (doc, place) pair consumes cap budget —
    // incrementing an existing observation, or observing a connected-bound
    // network, is always allowed.
    const newVisiblePair = isVisibleDoc && idx < 0;
    if (newVisiblePair && capReached) {
      logger.debug('[wifi-scan][upsertVisibleObservation] visible-binding cap reached — skipped', {
        userId,
        bssid: network.bssid,
        place: place.place_name,
        cap: VISIBLE_LEARN_CAP_PER_PLACE,
      });
      return;
    }

    if (idx >= 0) {
      observations[idx] = {
        ...observations[idx],
        count: observations[idx].count + 1,
        last_seen: timestamp,
        place_name: place.place_name, // refresh in case the place was renamed
      };
    } else {
      observations.push({
        place_id: place.place_id,
        place_name: place.place_name,
        count: 1,
        last_seen: timestamp,
      });
    }

    // G8: cap to the strongest observations (count desc, last_seen desc).
    let capped = observations;
    if (observations.length > MAX_PLACE_OBSERVATIONS) {
      capped = [...observations]
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
        })
        .slice(0, MAX_PLACE_OBSERVATIONS);
    }

    const doc: NetworkDoc = {
      user_id: userId,
      bssid: network.bssid,
      ssid: network.ssid ?? existing?.ssid,
      place_observations: capped,
      manual_place_id: existing?.manual_place_id,
      manual_place_name: existing?.manual_place_name,
      // Preserve an existing binding (absent = legacy connected); only docs
      // this path CREATES are stamped visible.
      binding: existing ? existing.binding : 'visible',
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

    countsTowardCap = isVisibleDoc;
    logger.debug('[wifi-scan][upsertVisibleObservation] visible observation recorded', {
      userId,
      bssid: network.bssid,
      place: place.place_name,
      rssi: network.rssi,
      binding: doc.binding ?? 'connected',
    });
  });

  return countsTowardCap;
}

/**
 * Process a `wifi_scan` push item (DECISION-021):
 * 1. Store the scan as ONE doc in ll5_awareness_wifi_scans (nested networks).
 * 2. AUTO-LEARN: when the location-state doc says the user is confidently AT a
 *    known place (kind === 'place', with a place_id, last confirmed within
 *    SCAN_FRESH_MS of the scan), upsert `visible` bindings for that place from
 *    the scan's networks — min RSSI VISIBLE_MIN_RSSI_LEARN, at most
 *    VISIBLE_LEARN_CAP_PER_PLACE visible bindings per place.
 */
export async function processWifiScan(
  es: Client,
  userId: string,
  item: PushWifiScanItem,
): Promise<void> {
  const { timestamp, networks, connected_bssid } = item.data;

  await es.index({
    index: SCANS_INDEX,
    id: crypto.randomUUID(),
    document: {
      user_id: userId,
      timestamp,
      networks: networks.map((n) => {
        const doc: Record<string, unknown> = { ssid: n.ssid, bssid: n.bssid, rssi: n.rssi };
        if (n.frequency_mhz !== undefined) doc.frequency_mhz = n.frequency_mhz;
        return doc;
      }),
      connected_bssid: connected_bssid ?? null,
    },
    refresh: false,
  });

  logger.info('[wifi-scan][processWifiScan] Scan stored', {
    userId,
    networks: networks.length,
    connected_bssid: connected_bssid ?? null,
  });

  // ---- Auto-learn visible bindings -----------------------------------------
  const state = await getLocationState(es, userId);
  const lastSeenMs = state?.last_seen ? new Date(state.last_seen).getTime() : NaN;
  const confidentlyAtPlace =
    state?.kind === 'place' &&
    !!state.place_id &&
    Number.isFinite(lastSeenMs) &&
    Math.abs(new Date(timestamp).getTime() - lastSeenMs) <= SCAN_FRESH_MS;

  if (!confidentlyAtPlace) {
    logger.debug('[wifi-scan][processWifiScan] Auto-learn skipped: not confidently at a known place', {
      userId,
      state_kind: state?.kind ?? null,
      state_label: state?.label ?? null,
      state_last_seen: state?.last_seen ?? null,
    });
    return;
  }

  const place = { place_id: state!.place_id!, place_name: state!.label };
  const eligible = networks.filter((n) => n.bssid && n.rssi >= VISIBLE_MIN_RSSI_LEARN);
  if (eligible.length === 0) return;

  const visibleSet = await getVisibleBssidsForPlace(es, userId, place.place_id);
  if (visibleSet === null) return; // cap unknown — don't learn blind

  for (const n of eligible) {
    const capReached =
      !visibleSet.has(n.bssid) && visibleSet.size >= VISIBLE_LEARN_CAP_PER_PLACE;
    const counted = await upsertVisibleObservation(
      es,
      userId,
      { bssid: n.bssid, ssid: n.ssid ?? null, rssi: n.rssi },
      place,
      timestamp,
      capReached,
    );
    if (counted) visibleSet.add(n.bssid);
  }

  logger.info('[wifi-scan][processWifiScan] Auto-learn pass complete', {
    userId,
    place: place.place_name,
    eligible: eligible.length,
    visible_at_place: visibleSet.size,
  });
}
