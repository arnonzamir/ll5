import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { chatAuthMiddleware } from './chat.js';
import { getEffectiveTimezone, startOfDayInTz, endOfDayInTz } from './utils/timezone.js';
import { logger } from './utils/logger.js';

/**
 * Map plane (android-companion-ui Phase 4, spec §7) — a calm snapshot of
 * "where is everyone", never a surveillance feed. One aggregation call:
 *
 *   devices     — current fixes from ll5_awareness_tracked_devices (the Find
 *                 Hub upserts keep exactly ONE doc per device, so "latest per
 *                 device" is simply every doc)
 *   places      — saved places with coordinates from ll5_knowledge_places
 *   trail_today — the user's OWN GPS trail for today (effective tz) from
 *                 ll5_awareness_locations, suspect fixes excluded (a spoofed
 *                 fix is NOT the user's location), downsampled to ≤200 points,
 *                 oldest first
 *
 * FROZEN CONTRACT — the Android app is built against these exact shapes.
 * Per-section degrade: a missing index (fresh deploy) yields an empty array
 * WITH a logger.warn; real ES failures still 500 — never silent defaults.
 */

const DEVICES_INDEX = 'll5_awareness_tracked_devices';
const PLACES_INDEX = 'll5_knowledge_places';
const LOCATIONS_INDEX = 'll5_awareness_locations';

/** Trail cap — enough for a day's shape, cheap enough for a phone polyline. */
export const TRAIL_MAX_POINTS = 200;
/** Raw fetch ceiling for a day of GPS fixes before downsampling. */
const TRAIL_FETCH_SIZE = 5000;
/** Default place radius when the doc doesn't carry one (same as the mapping's documented default). */
const DEFAULT_PLACE_RADIUS_M = 100;

export interface MapDevice {
  name: string;
  lat: number;
  lon: number;
  /** When the Find Hub network last located the device (ISO). */
  seen_at: string;
}

export interface MapPlace {
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
}

export interface TrailPoint {
  lat: number;
  lon: number;
  /** ISO timestamp of the fix. */
  ts: string;
}

export interface MapResponse {
  devices: MapDevice[];
  places: MapPlace[];
  trail_today: TrailPoint[];
}

interface GeoPoint { lat?: number; lon?: number }

function coords(geo: GeoPoint | undefined): { lat: number; lon: number } | null {
  const lat = geo?.lat;
  const lon = geo?.lon;
  return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null;
}

function isMissingIndex(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/index_not_found_exception/.test(message)) return true;
  const type = (err as { meta?: { body?: { error?: { type?: string } } } } | null)
    ?.meta?.body?.error?.type;
  return type === 'index_not_found_exception';
}

/**
 * Downsample a trail to ≤ max points by taking every Nth (stride = ceil(n/max)),
 * oldest first, always preserving the final point so the trail ends where the
 * user actually is.
 */
export function downsampleTrail<T>(points: T[], max = TRAIL_MAX_POINTS): T[] {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const sampled = points.filter((_, i) => i % stride === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) {
    if (sampled.length >= max) sampled[sampled.length - 1] = last;
    else sampled.push(last);
  }
  return sampled;
}

/** Run one map section; a missing index degrades to [] with a warn. */
async function section<T>(name: string, index: string, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingIndex(err)) {
      logger.warn(`[map][${name}] index missing — empty section`, { index });
      return [];
    }
    throw err;
  }
}

export interface MapRouterOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createMapRouter(
  pool: Pool,
  es: Client,
  authSecret: string,
  options: MapRouterOptions = {},
): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);
  const nowFn = options.now ?? (() => new Date());

  async function readDevices(userId: string): Promise<MapDevice[]> {
    const result = await es.search({
      index: DEVICES_INDEX,
      query: { bool: { filter: [{ term: { user_id: userId } }] } },
      sort: [{ last_seen: 'desc' }],
      size: 100,
      _source: ['name', 'location', 'last_seen'],
    });
    return (result.hits.hits as Array<{
      _source?: { name?: string; location?: GeoPoint; last_seen?: string };
    }>)
      .map((h) => {
        const c = coords(h._source?.location);
        if (!c || !h._source?.last_seen) return null;
        return {
          name: h._source.name ?? '(unnamed device)',
          lat: c.lat,
          lon: c.lon,
          seen_at: new Date(h._source.last_seen).toISOString(),
        };
      })
      .filter((d): d is MapDevice => d !== null);
  }

  async function readPlaces(userId: string): Promise<MapPlace[]> {
    const result = await es.search({
      index: PLACES_INDEX,
      query: {
        bool: {
          filter: [{ term: { user_id: userId } }, { exists: { field: 'geo' } }],
        },
      },
      size: 1000,
      _source: ['name', 'geo', 'radius_m'],
    });
    return (result.hits.hits as Array<{
      _source?: { name?: string; geo?: GeoPoint; radius_m?: number | null };
    }>)
      .map((h) => {
        const c = coords(h._source?.geo);
        if (!c) return null;
        return {
          name: h._source?.name ?? '(unnamed place)',
          lat: c.lat,
          lon: c.lon,
          radius_m: typeof h._source?.radius_m === 'number'
            ? h._source.radius_m
            : DEFAULT_PLACE_RADIUS_M,
        };
      })
      .filter((p): p is MapPlace => p !== null);
  }

  async function readTrail(userId: string, now: Date, tz: string): Promise<TrailPoint[]> {
    const result = await es.search({
      index: LOCATIONS_INDEX,
      query: {
        bool: {
          filter: [
            { term: { user_id: userId } },
            {
              range: {
                timestamp: {
                  gte: startOfDayInTz(now, tz).toISOString(),
                  lt: endOfDayInTz(now, tz).toISOString(),
                },
              },
            },
          ],
          // Spoofed/teleporting fixes are flagged, not deleted — never draw them.
          must_not: [{ term: { suspect: true } }],
        },
      },
      sort: [{ timestamp: 'asc' }],
      size: TRAIL_FETCH_SIZE,
      _source: ['location', 'timestamp'],
    });
    const points = (result.hits.hits as Array<{
      _source?: { location?: GeoPoint; timestamp?: string };
    }>)
      .map((h) => {
        const c = coords(h._source?.location);
        if (!c || !h._source?.timestamp) return null;
        return { lat: c.lat, lon: c.lon, ts: new Date(h._source.timestamp).toISOString() };
      })
      .filter((p): p is TrailPoint => p !== null);
    return downsampleTrail(points);
  }

  // GET /me/map — devices + places + today's own trail, one call.
  router.get('/me/map', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const now = nowFn();
      const tz = await getEffectiveTimezone(pool, userId);
      const [devices, places, trailToday] = await Promise.all([
        section('devices', DEVICES_INDEX, () => readDevices(userId)),
        section('places', PLACES_INDEX, () => readPlaces(userId)),
        section('trail', LOCATIONS_INDEX, () => readTrail(userId, now, tz)),
      ]);
      const payload: MapResponse = { devices, places, trail_today: trailToday };
      res.json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[map][get] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
