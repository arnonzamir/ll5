import type { Client } from '@elastic/elasticsearch';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { WifiRepository } from '../repositories/interfaces/wifi.repository.js';
import { logger } from '../utils/logger.js';

const GPS_FRESH_MS = 5 * 60 * 1000;
const GPS_STALE_USABLE_MS = 15 * 60 * 1000;
const WIFI_FRESH_MS = 10 * 60 * 1000;

type Confidence = 'high' | 'medium' | 'low' | 'unknown';
type Source = 'gps' | 'wifi' | 'gps+wifi' | 'stale_gps' | 'none';

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

export interface CurrentLocation {
  place: string | null;
  place_id: string | null;
  confidence: Confidence;
  source: Source;
  reasoning: string;
  gps?: GpsBlock;
  wifi?: WifiBlock;
}

interface NetworkDoc {
  manual_place_id?: string;
  manual_place_name?: string;
  place_observations?: Array<{
    place_id: string;
    place_name: string;
    count: number;
    last_seen: string;
  }>;
}

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

    const gpsBlock: GpsBlock | undefined = latestGps
      ? {
          lat: latestGps.location.lat,
          lon: latestGps.location.lon,
          accuracy_m: latestGps.accuracy,
          age_s: Math.floor((now - new Date(latestGps.timestamp).getTime()) / 1000),
          freshness:
            now - new Date(latestGps.timestamp).getTime() < GPS_FRESH_MS
              ? 'fresh'
              : now - new Date(latestGps.timestamp).getTime() < GPS_STALE_USABLE_MS
                ? 'stale'
                : 'very_stale',
          matched_place: latestGps.matchedPlace ?? null,
          address: latestGps.address ?? null,
        }
      : undefined;

    let wifiBlock: WifiBlock | undefined;
    if (latestWifi && latestWifi.connected) {
      const wifiAgeMs = now - new Date(latestWifi.timestamp).getTime();
      const placeFromBssid =
        latestWifi.bssid && wifiAgeMs < WIFI_FRESH_MS
          ? await this.lookupBssidPlace(userId, latestWifi.bssid)
          : null;
      wifiBlock = {
        bssid: latestWifi.bssid,
        ssid: latestWifi.ssid,
        connected: latestWifi.connected,
        age_s: Math.floor(wifiAgeMs / 1000),
        place_from_bssid: placeFromBssid,
      };
    }

    return this.fuse(gpsBlock, wifiBlock);
  }

  private fuse(gps: GpsBlock | undefined, wifi: WifiBlock | undefined): CurrentLocation {
    const gpsFresh = gps?.freshness === 'fresh';
    const gpsUsable = gps && gps.freshness !== 'very_stale';
    const wifiFresh = wifi && wifi.age_s * 1000 < WIFI_FRESH_MS;
    const wifiPlace = wifi?.place_from_bssid ?? null;

    // 1. Fresh GPS + matched place + wifi agrees
    if (
      gpsFresh &&
      gps.matched_place &&
      wifiFresh &&
      wifiPlace?.place_name === gps.matched_place
    ) {
      return {
        place: gps.matched_place,
        place_id: wifiPlace.place_id,
        confidence: 'high',
        source: 'gps+wifi',
        reasoning: `GPS (${gps.age_s}s) at ${gps.matched_place}, wifi confirms`,
        gps,
        wifi,
      };
    }

    // 2. Fresh GPS + matched place
    if (gpsFresh && gps.matched_place) {
      return {
        place: gps.matched_place,
        place_id: null,
        confidence: 'high',
        source: 'gps',
        reasoning: `GPS fix (${gps.age_s}s old) at ${gps.matched_place}`,
        gps,
        wifi,
      };
    }

    // 3. Stale GPS, wifi fresh, BSSID resolves
    if (!gpsFresh && wifiFresh && wifiPlace) {
      return {
        place: wifiPlace.place_name,
        place_id: wifiPlace.place_id,
        confidence: 'medium',
        source: 'wifi',
        reasoning: `GPS stale (${gps?.age_s ?? 'n/a'}s), wifi BSSID maps to ${wifiPlace.place_name}`,
        gps,
        wifi,
      };
    }

    // 4. Fresh GPS without matched place + wifi resolves
    if (gpsFresh && !gps.matched_place && wifiFresh && wifiPlace) {
      return {
        place: wifiPlace.place_name,
        place_id: wifiPlace.place_id,
        confidence: 'medium',
        source: 'gps+wifi',
        reasoning: `GPS fresh but no place match; wifi BSSID → ${wifiPlace.place_name}`,
        gps,
        wifi,
      };
    }

    // 5. Fresh GPS without matched place, no wifi
    if (gpsFresh && !gps.matched_place) {
      return {
        place: null,
        place_id: null,
        confidence: 'low',
        source: 'gps',
        reasoning: `GPS fresh at (${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)}) — no known place`,
        gps,
        wifi,
      };
    }

    // 6. Stale GPS, no wifi signal
    if (gpsUsable) {
      return {
        place: gps.matched_place ?? null,
        place_id: null,
        confidence: 'low',
        source: 'stale_gps',
        reasoning: `GPS stale (${gps.age_s}s old), no wifi`,
        gps,
        wifi,
      };
    }

    // 7. Nothing
    return {
      place: null,
      place_id: null,
      confidence: 'unknown',
      source: 'none',
      reasoning: 'No recent GPS or wifi signal',
      gps,
      wifi,
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
