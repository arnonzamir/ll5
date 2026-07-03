import type { Client } from '@elastic/elasticsearch';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { WifiRepository } from '../repositories/interfaces/wifi.repository.js';
import type { WifiScanRepository } from '../repositories/interfaces/wifi-scan.repository.js';
import type { WifiScanNetwork } from '../types/wifi.js';
import {
  resolveLocation,
  freshnessLabel,
  precisionLabel,
  speedKmh,
  cardinal,
  GPS_FRESH_MS,
  WIFI_CONNECTED_ANCHOR_MS,
  SCAN_FRESH_MS,
  BSSID_MIN_OBSERVATIONS,
  type GpsSignal,
  type WifiSignal,
  type VisibleScanSignal,
  type VisibleKnownNetwork,
  type Confidence,
  type LocationSource,
  type Motion,
  type Freshness,
  type Precision,
} from '@ll5/shared';
import { logger } from '../utils/logger.js';

/** Window + cap for the recent-trail the snapshot carries, so the agent can read
 *  trajectory (heading toward / away) and infer a destination. */
const TRAIL_WINDOW_MS = 30 * 60 * 1000;
const TRAIL_MAX_POINTS = 12;

/** Where the user is right now, with precision + recency, as one block. */
export interface PositionBlock {
  lat: number;
  lon: number;
  accuracy_m: number | null;
  /** Bucketed from accuracy: high / approximate / coarse / unknown. */
  precision: Precision;
  timestamp: string;
  age_s: number;
  /** live / recent / stale / unknown — same vocabulary everywhere. */
  freshness: Freshness;
  road: string | null;
  neighborhood: string | null;
  city: string | null;
  address: string | null;
}

/** One past fix in the recent trail. Newest first. */
export interface TrailPoint {
  lat: number;
  lon: number;
  timestamp: string;
  age_s: number;
  speed_mps: number | null;
  place: string | null;
}

export interface Heading {
  bearing_deg: number;
  cardinal: string;
}

/** The visible-scan fingerprint block (DECISION-021): what the phone could SEE
 *  in the latest fresh scan, and which of those networks map to known places.
 *  Omitted entirely when the latest scan is stale (> SCAN_FRESH_MS) or absent. */
export interface VisibleWifiBlock {
  scan_age_s: number;
  total_visible: number;
  known: Array<{ place: string; ssid: string | null; rssi: number }>;
}

export interface WifiBlock {
  bssid: string | null;
  ssid: string | null;
  connected: boolean;
  age_s: number;
  place_from_bssid?: { place_id: string; place_name: string } | null;
  visible?: VisibleWifiBlock;
}

export interface RecentlyLeft {
  place_name: string;
  place_id: string;
  age_s: number;
}

/**
 * The single rich "where is the user" snapshot the agent gets in ONE call. The
 * MCP does the deterministic part — fuse the signals, classify motion/precision/
 * freshness, attach the recent trail — and hands ALL of it over. The agent does
 * the deduction (is this cycling or driving? heading to school?) and the phrasing.
 * `description` is a deterministic baseline/floor, not a line to parrot verbatim.
 */
export interface CurrentLocation {
  place: string | null;
  place_id: string | null;
  confidence: Confidence;
  source: LocationSource;
  reasoning: string;
  /** Deterministic baseline phrasing ("driving on Route 6, heading south — near
   *  Hadera"). A floor to fall back on — the agent is free to compose better. */
  description: string;
  /** Coarse motion bucket from device speed: stationary / walking / driving /
   *  unknown. Use with `speed_kmh` to refine (e.g. ~18 km/h on a bike path → cycling). */
  motion: Motion;
  speed_mps: number | null;
  speed_kmh: number | null;
  heading?: Heading;
  position?: PositionBlock;
  /** Recent fixes (newest first), for trajectory / destination inference. */
  trail: TrailPoint[];
  wifi?: WifiBlock;
  /**
   * Additive context only: set when GPS is not fresh and the most recent wifi
   * event is a recent DISCONNECT whose BSSID maps to a known place. A "where the
   * user was just before this stale/unknown reading" hint.
   */
  recently_left?: RecentlyLeft;
}

interface NetworkDoc {
  user_id?: string;
  manual_place_id?: string;
  manual_place_name?: string;
  place_observations?: Array<{
    place_id: string;
    place_name: string;
    count: number;
    last_seen: string;
  }>;
}

/**
 * Read-path location resolver for the awareness MCP. It fetches the latest GPS +
 * wifi from the repositories, resolves the BSSID→place binding, then delegates
 * the actual "where am I" decision to the shared canonical resolver
 * (`@ll5/shared` `resolveLocation`) — the exact same brain the gateway's
 * write/transition path uses, so the agent and the notifications can't disagree.
 */
export class LocationService {
  constructor(
    private readonly locationRepo: LocationRepository,
    private readonly wifiRepo: WifiRepository,
    private readonly es: Client,
    /** Optional so older wirings/tests keep working; without it the visible
     *  fingerprint block + resolver tier simply don't engage. */
    private readonly wifiScanRepo?: WifiScanRepository,
  ) {}

  async getCurrentLocation(userId: string): Promise<CurrentLocation> {
    const now = Date.now();
    const [latestGps, latestWifi, latestScan, recent] = await Promise.all([
      this.locationRepo.getLatest(userId),
      this.wifiRepo.getLatest(userId),
      this.wifiScanRepo ? this.wifiScanRepo.getLatest(userId) : Promise.resolve(null),
      this.locationRepo.query(userId, {
        startTime: new Date(now - TRAIL_WINDOW_MS).toISOString(),
        endTime: new Date(now).toISOString(),
        limit: TRAIL_MAX_POINTS,
      }),
    ]);

    // --- GPS: position block + shared signal ---
    const gpsAgeMs = latestGps ? now - new Date(latestGps.timestamp).getTime() : 0;
    const gpsFresh = !!latestGps && gpsAgeMs < GPS_FRESH_MS;

    const positionBlock: PositionBlock | undefined = latestGps
      ? {
          lat: latestGps.location.lat,
          lon: latestGps.location.lon,
          accuracy_m: latestGps.accuracy ?? null,
          precision: precisionLabel(latestGps.accuracy),
          timestamp: latestGps.timestamp,
          age_s: Math.floor(gpsAgeMs / 1000),
          freshness: freshnessLabel(gpsAgeMs),
          road: latestGps.road ?? null,
          neighborhood: latestGps.neighborhood ?? null,
          city: latestGps.city ?? null,
          address: latestGps.address ?? null,
        }
      : undefined;

    // --- Recent trail (newest first) for trajectory / destination inference ---
    const trail: TrailPoint[] = recent.map((loc) => ({
      lat: loc.location.lat,
      lon: loc.location.lon,
      timestamp: loc.timestamp,
      age_s: Math.floor((now - new Date(loc.timestamp).getTime()) / 1000),
      speed_mps: loc.speed ?? null,
      place: loc.matchedPlace ?? null,
    }));

    const heading: Heading | undefined =
      latestGps?.bearing != null
        ? { bearing_deg: latestGps.bearing, cardinal: cardinal(latestGps.bearing) }
        : undefined;

    const gpsSignal: GpsSignal | undefined = latestGps
      ? {
          lat: latestGps.location.lat,
          lon: latestGps.location.lon,
          accuracyM: latestGps.accuracy,
          ageMs: gpsAgeMs,
          matchedPlace: latestGps.matchedPlace
            ? { placeId: latestGps.matchedPlaceId ?? '', placeName: latestGps.matchedPlace }
            : null,
          // The context that turns a bare city into a useful description.
          city: latestGps.city ?? null,
          road: latestGps.road ?? null,
          neighborhood: latestGps.neighborhood ?? null,
          bearingDeg: latestGps.bearing ?? null,
          speedMps: latestGps.speed ?? null,
        }
      : undefined;

    // --- Wifi: resolve BSSID→place, build response block + shared signal ---
    let wifiBlock: WifiBlock | undefined;
    let wifiSignal: WifiSignal | undefined;
    if (latestWifi) {
      const wifiAgeMs = now - new Date(latestWifi.timestamp).getTime();
      // Resolve within the connected-anchor window for connected events (sparse
      // heartbeats), and for a recent disconnect when GPS isn't fresh (recently-left).
      const shouldResolve =
        !!latestWifi.bssid && wifiAgeMs < WIFI_CONNECTED_ANCHOR_MS && (latestWifi.connected || !gpsFresh);
      const bssidPlace = shouldResolve
        ? await this.lookupBssidPlace(userId, latestWifi.bssid!)
        : null;

      if (latestWifi.connected) {
        wifiBlock = {
          bssid: latestWifi.bssid,
          ssid: latestWifi.ssid,
          connected: latestWifi.connected,
          age_s: Math.floor(wifiAgeMs / 1000),
          place_from_bssid: bssidPlace,
        };
      }

      wifiSignal = {
        bssid: latestWifi.bssid,
        ssid: latestWifi.ssid,
        connected: latestWifi.connected,
        ageMs: wifiAgeMs,
        // lookupBssidPlace already applies the manual / >=3-observations threshold,
        // so any place it returns is confident.
        bssidPlace: bssidPlace
          ? { placeId: bssidPlace.place_id, placeName: bssidPlace.place_name, confident: true }
          : null,
      };
    }

    // --- Visible-scan fingerprint (DECISION-021): latest scan, fresh only ---
    // Match the scan's BSSIDs against known_networks bindings (connected AND
    // visible) and feed the matched set into the shared resolver, so the place
    // resolution itself benefits — the read-path half of the DECISION-009
    // symmetry (the gateway write path passes the same signal).
    let visibleBlock: VisibleWifiBlock | undefined;
    let visibleSignal: VisibleScanSignal | undefined;
    if (latestScan && latestScan.networks.length > 0) {
      const scanAgeMs = now - new Date(latestScan.timestamp).getTime();
      if (scanAgeMs < SCAN_FRESH_MS) {
        const matched = await this.matchScanNetworks(userId, latestScan.networks);
        visibleBlock = {
          scan_age_s: Math.floor(scanAgeMs / 1000),
          total_visible: latestScan.networks.length,
          known: matched.map((m) => ({
            place: m.place.placeName,
            ssid: m.ssid ?? null,
            rssi: m.rssi,
          })),
        };
        if (matched.length > 0) {
          visibleSignal = { ageMs: scanAgeMs, networks: matched };
        }
      }
      // stale scan → block omitted entirely, resolver sees nothing
    }

    if (visibleBlock) {
      if (wifiBlock) {
        wifiBlock.visible = visibleBlock;
      } else {
        // Not connected to anything, but the scan still says what's around.
        wifiBlock = {
          bssid: null,
          ssid: null,
          connected: false,
          age_s: visibleBlock.scan_age_s,
          visible: visibleBlock,
        };
      }
    }

    // No `prior` on the read path → pure fusion (no departure hysteresis).
    const resolved = resolveLocation({ gps: gpsSignal, wifi: wifiSignal, visibleKnown: visibleSignal });

    if (resolved.source === 'wifi' || resolved.source === 'gps+wifi' || resolved.source === 'wifi_scan') {
      logger.debug('[LocationService][getCurrentLocation] resolved with wifi assist', {
        source: resolved.source,
        confidence: resolved.confidence,
      });
    }

    return {
      place: resolved.place,
      place_id: resolved.placeId,
      confidence: resolved.confidence,
      source: resolved.source,
      reasoning: resolved.reasoning,
      description: resolved.description,
      motion: resolved.motion,
      speed_mps: latestGps?.speed ?? null,
      speed_kmh: speedKmh(latestGps?.speed),
      heading,
      position: positionBlock,
      trail,
      wifi: wifiBlock,
      recently_left: resolved.recentlyLeft
        ? {
            place_name: resolved.recentlyLeft.placeName,
            place_id: resolved.recentlyLeft.placeId,
            age_s: resolved.recentlyLeft.ageS,
          }
        : undefined,
    };
  }

  /**
   * Match the scan's BSSIDs against known_networks in ONE mget. A network
   * matches when its doc carries a manual binding or a dominant place with
   * >= BSSID_MIN_OBSERVATIONS observations — the same confidence rule as the
   * connected anchor. Both `connected` and `visible` bindings participate:
   * the binding field describes provenance, not matching eligibility.
   * Resilient — any failure returns [] so a networks-index hiccup never breaks
   * where_is_user.
   */
  private async matchScanNetworks(
    userId: string,
    networks: WifiScanNetwork[],
  ): Promise<VisibleKnownNetwork[]> {
    try {
      const ids = networks.map((n) => `${userId}::${n.bssid}`);
      const res = await this.es.mget<NetworkDoc>({ index: 'll5_knowledge_networks', ids });
      const matched: VisibleKnownNetwork[] = [];
      res.docs.forEach((d, i) => {
        const doc = d as { found?: boolean; _source?: NetworkDoc };
        if (!doc.found || !doc._source) return;
        const src = doc._source;
        if (src.user_id !== userId) {
          logger.warn('cross_user_access_denied', {
            actor_user_id: userId,
            owner_user_id: src.user_id,
            resource: 'network',
            id: ids[i],
          });
          return;
        }
        let place: { placeId: string; placeName: string } | null = null;
        if (src.manual_place_id && src.manual_place_name) {
          place = { placeId: src.manual_place_id, placeName: src.manual_place_name };
        } else if (src.place_observations && src.place_observations.length > 0) {
          const dominant = [...src.place_observations].sort((a, b) => b.count - a.count)[0];
          if (dominant.count >= BSSID_MIN_OBSERVATIONS) {
            place = { placeId: dominant.place_id, placeName: dominant.place_name };
          }
        }
        if (!place) return;
        matched.push({
          bssid: networks[i].bssid,
          ssid: networks[i].ssid,
          rssi: networks[i].rssi,
          place: { ...place, confident: true },
        });
      });
      return matched;
    } catch (err) {
      logger.warn('[LocationService][matchScanNetworks] Failed (continuing without scan)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async lookupBssidPlace(
    userId: string,
    bssid: string,
  ): Promise<{ place_id: string; place_name: string } | null> {
    try {
      const docId = `${userId}::${bssid}`;
      const got = await this.es.get<NetworkDoc>({ index: 'll5_knowledge_networks', id: docId });
      const src = got._source;
      if (!src) return null;
      if (src.user_id !== userId) {
        logger.warn('cross_user_access_denied', {
          actor_user_id: userId,
          owner_user_id: src.user_id,
          resource: 'network',
          id: docId,
        });
        return null;
      }
      if (src.manual_place_id && src.manual_place_name) {
        return { place_id: src.manual_place_id, place_name: src.manual_place_name };
      }
      if (src.place_observations && src.place_observations.length > 0) {
        const dominant = [...src.place_observations].sort((a, b) => b.count - a.count)[0];
        if (dominant.count >= 3) {
          return { place_id: dominant.place_id, place_name: dominant.place_name };
        }
      }
      return null;
    } catch (err: unknown) {
      const e = err as { meta?: { statusCode?: number } };
      if (e.meta?.statusCode === 404) return null;
      logger.warn('[LocationService][lookupBssidPlace] Failed', {
        error: err instanceof Error ? err.message : String(err),
        bssid,
      });
      return null;
    }
  }
}
