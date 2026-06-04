import type { Client } from '@elastic/elasticsearch';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { WifiRepository } from '../repositories/interfaces/wifi.repository.js';
import {
  resolveLocation,
  GPS_FRESH_MS,
  GPS_STALE_USABLE_MS,
  WIFI_CONNECTED_ANCHOR_MS,
  type GpsSignal,
  type WifiSignal,
  type Confidence,
  type LocationSource,
} from '@ll5/shared';
import { logger } from '../utils/logger.js';

export interface GpsBlock {
  lat: number;
  lon: number;
  accuracy_m?: number;
  age_s: number;
  freshness: 'fresh' | 'stale' | 'very_stale';
  matched_place?: string | null;
  address?: string | null;
}

export interface WifiBlock {
  bssid: string | null;
  ssid: string | null;
  connected: boolean;
  age_s: number;
  place_from_bssid?: { place_id: string; place_name: string } | null;
}

export interface RecentlyLeft {
  place_name: string;
  place_id: string;
  age_s: number;
}

export interface CurrentLocation {
  place: string | null;
  place_id: string | null;
  confidence: Confidence;
  source: LocationSource;
  reasoning: string;
  gps?: GpsBlock;
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
  ) {}

  async getCurrentLocation(userId: string): Promise<CurrentLocation> {
    const [latestGps, latestWifi] = await Promise.all([
      this.locationRepo.getLatest(userId),
      this.wifiRepo.getLatest(userId),
    ]);

    const now = Date.now();

    // --- GPS: response block + shared signal ---
    const gpsAgeMs = latestGps ? now - new Date(latestGps.timestamp).getTime() : 0;
    const gpsFresh = !!latestGps && gpsAgeMs < GPS_FRESH_MS;

    const gpsBlock: GpsBlock | undefined = latestGps
      ? {
          lat: latestGps.location.lat,
          lon: latestGps.location.lon,
          accuracy_m: latestGps.accuracy,
          age_s: Math.floor(gpsAgeMs / 1000),
          freshness:
            gpsAgeMs < GPS_FRESH_MS ? 'fresh' : gpsAgeMs < GPS_STALE_USABLE_MS ? 'stale' : 'very_stale',
          matched_place: latestGps.matchedPlace ?? null,
          address: latestGps.address ?? null,
        }
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

    // No `prior` on the read path → pure fusion (no departure hysteresis).
    const resolved = resolveLocation({ gps: gpsSignal, wifi: wifiSignal });

    if (resolved.source === 'wifi' || resolved.source === 'gps+wifi') {
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
      gps: gpsBlock,
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
