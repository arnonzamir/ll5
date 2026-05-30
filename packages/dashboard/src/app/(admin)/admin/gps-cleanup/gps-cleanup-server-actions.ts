"use server";

import { env } from "@/lib/env";
import { getToken, decodeTokenPayload } from "@/lib/auth";
import { DEFAULT_GEO_BOUNDS, isOutOfBounds, type GeoBounds } from "./gps-bounds";

/**
 * Dashboard-side GPS cleanup. Applies the same filters the gateway processor
 * would have rejected before the 2026-04-23 fixes to `accuracy_m` and the
 * haversine drift filter. Uses direct ES access (same pattern as
 * admin/logs/log-server-actions.ts) because ES is not publicly exposed.
 */

const INDEX = "ll5_awareness_locations";
const MIN_ACCURACY_METERS = 100;
const MAX_PLAUSIBLE_SPEED_KMH = 150;
const DRIFT_WINDOW_MS = 10 * 60 * 1000;
const PLACE_DRIFT_DISTANCE_KM = 0.5;
const PLACE_DRIFT_WINDOW_MS = 5 * 60 * 1000;

export type { GeoBounds };

export type TimeRange = "1d" | "3d" | "7d" | "30d" | "all";

/**
 * Optional geo-boundary criterion (gap G7). The out-of-bounds check is OPT-IN:
 * when `enabled` is false (the default), no point is flagged as out-of-bounds,
 * making the scan safe to run while or after traveling abroad. When enabled,
 * `bounds` defaults to {@link DEFAULT_GEO_BOUNDS} (Israel) but the caller may
 * pass its own box.
 */
export interface GeoFilterOptions {
  enabled: boolean;
  bounds?: GeoBounds;
}

const TIME_RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

interface LocDoc {
  user_id?: string;
  location?: { lat: number; lon: number };
  accuracy?: number;
  matched_place?: string;
  matched_place_id?: string;
  timestamp?: string;
}

interface LocHit {
  _id: string;
  _source?: LocDoc;
  sort?: unknown[];
}

export type BadReason = "accuracy" | "speed" | "place_drift" | "out_of_israel";

export interface BadPoint {
  id: string;
  timestamp: string;
  lat: number;
  lon: number;
  accuracy?: number;
  matched_place?: string;
  reason: BadReason;
  detail: string;
}

export interface GpsScanResult {
  totalScanned: number;
  timeRange: TimeRange;
  badAccuracy: BadPoint[];
  badSpeed: BadPoint[];
  badPlaceDrift: BadPoint[];
  badOutOfIsrael: BadPoint[];
  uniqueBadIds: string[];
}

function haversineKm(
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

async function getCurrentUserId(): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;
  const payload = decodeTokenPayload(token);
  const uid = payload?.uid ?? payload?.user_id;
  return typeof uid === "string" ? uid : null;
}

async function fetchAllPoints(userId: string, timeRange: TimeRange): Promise<LocHit[]> {
  const baseUrl = env.ELASTICSEARCH_URL;
  const points: LocHit[] = [];
  let searchAfter: unknown[] | null = null;
  const PAGE = 1000;

  const filters: Record<string, unknown>[] = [{ term: { user_id: userId } }];
  if (timeRange !== "all") {
    const since = new Date(Date.now() - TIME_RANGE_MS[timeRange]).toISOString();
    filters.push({ range: { timestamp: { gte: since } } });
  }

  while (true) {
    const body: Record<string, unknown> = {
      size: PAGE,
      query: { bool: { filter: filters } },
      sort: [{ timestamp: { order: "asc" } }, { _id: { order: "asc" } }],
      _source: [
        "user_id",
        "location",
        "accuracy",
        "matched_place",
        "matched_place_id",
        "timestamp",
      ],
    };
    if (searchAfter) body.search_after = searchAfter;

    const res = await fetch(`${baseUrl}/${INDEX}/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ES search failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as {
      hits: { hits: LocHit[] };
    };
    const hits = data.hits.hits;
    if (hits.length === 0) break;
    points.push(...hits);
    if (hits.length < PAGE) break;
    searchAfter = hits[hits.length - 1].sort ?? null;
    if (!searchAfter) break;
  }

  return points;
}

export async function scanBadGpsPoints(
  timeRange: TimeRange = "all",
  // Gap G7: out-of-bounds is opt-in. Omit/disable to never flag points as
  // out-of-bounds (safe while traveling abroad).
  geoFilter: GeoFilterOptions = { enabled: false },
): Promise<{ ok: true; result: GpsScanResult } | { ok: false; error: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { ok: false, error: "Not authenticated" };

  const geoBounds = geoFilter.enabled ? geoFilter.bounds ?? DEFAULT_GEO_BOUNDS : null;

  try {
    const points = await fetchAllPoints(userId, timeRange);
    const badAccuracy: BadPoint[] = [];
    const badSpeed: BadPoint[] = [];
    const badPlaceDrift: BadPoint[] = [];
    const badOutOfIsrael: BadPoint[] = [];

    for (let i = 0; i < points.length; i++) {
      const cur = points[i];
      const src = cur._source;
      if (!src?.location || !src.timestamp) continue;

      // Criterion A — accuracy over threshold
      if (src.accuracy != null && src.accuracy > MIN_ACCURACY_METERS) {
        badAccuracy.push({
          id: cur._id,
          timestamp: src.timestamp,
          lat: src.location.lat,
          lon: src.location.lon,
          accuracy: src.accuracy,
          matched_place: src.matched_place,
          reason: "accuracy",
          detail: `accuracy=${Math.round(src.accuracy)}m (threshold ${MIN_ACCURACY_METERS}m)`,
        });
      }

      // Criterion D — outside geo bounding box (opt-in; gap G7). When
      // geoBounds is null the criterion is disabled and nothing is flagged.
      if (geoBounds && isOutOfBounds(src.location, geoBounds)) {
        badOutOfIsrael.push({
          id: cur._id,
          timestamp: src.timestamp,
          lat: src.location.lat,
          lon: src.location.lon,
          accuracy: src.accuracy,
          matched_place: src.matched_place,
          reason: "out_of_israel",
          detail: `(${src.location.lat.toFixed(3)}, ${src.location.lon.toFixed(3)}) outside bbox`,
        });
      }

      if (i === 0) continue;
      const prev = points[i - 1];
      const prevSrc = prev._source;
      if (!prevSrc?.location || !prevSrc.timestamp) continue;

      const dtMs = new Date(src.timestamp).getTime() - new Date(prevSrc.timestamp).getTime();
      if (dtMs <= 0) continue;

      const distKm = haversineKm(prevSrc.location, src.location);

      // Criterion B — implausible speed (>150 km/h within 10 min)
      if (dtMs < DRIFT_WINDOW_MS) {
        const speedKmh = distKm / (dtMs / 3600000);
        if (speedKmh > MAX_PLAUSIBLE_SPEED_KMH) {
          badSpeed.push({
            id: cur._id,
            timestamp: src.timestamp,
            lat: src.location.lat,
            lon: src.location.lon,
            accuracy: src.accuracy,
            matched_place: src.matched_place,
            reason: "speed",
            detail: `${Math.round(speedKmh)} km/h over ${Math.round(distKm * 10) / 10} km in ${Math.round(dtMs / 60000)} min`,
          });
        }
      }

      // Criterion C — drift from known place (>500m within 5 min of a known-place point)
      if (
        prevSrc.matched_place &&
        distKm > PLACE_DRIFT_DISTANCE_KM &&
        dtMs < PLACE_DRIFT_WINDOW_MS
      ) {
        badPlaceDrift.push({
          id: cur._id,
          timestamp: src.timestamp,
          lat: src.location.lat,
          lon: src.location.lon,
          accuracy: src.accuracy,
          matched_place: src.matched_place,
          reason: "place_drift",
          detail: `${Math.round(distKm * 1000)}m from ${prevSrc.matched_place} in ${Math.round(dtMs / 60000)} min`,
        });
      }
    }

    const uniqueBadIds = Array.from(
      new Set([
        ...badAccuracy.map((p) => p.id),
        ...badSpeed.map((p) => p.id),
        ...badPlaceDrift.map((p) => p.id),
        ...badOutOfIsrael.map((p) => p.id),
      ]),
    );

    console.log(
      `[gps-cleanup] scan range=${timeRange} scanned=${points.length} ` +
        `accuracy=${badAccuracy.length} speed=${badSpeed.length} ` +
        `place_drift=${badPlaceDrift.length} ` +
        `out_of_bounds=${geoBounds ? badOutOfIsrael.length : "off"} ` +
        `unique=${uniqueBadIds.length}`,
    );

    return {
      ok: true,
      result: {
        totalScanned: points.length,
        timeRange,
        badAccuracy,
        badSpeed,
        badPlaceDrift,
        badOutOfIsrael,
        uniqueBadIds,
      },
    };
  } catch (err) {
    console.error(
      "[gps-cleanup] scan failed:",
      err instanceof Error ? err.message : String(err),
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * One-click: scan by time range, immediately delete points matching the
 * given criteria, return before/after counts. Use when you trust the filters
 * and don't want to preview — e.g., routine cleanup of jumpy + out-of-country
 * points in the recent window.
 */
export async function scanAndDelete(
  timeRange: TimeRange,
  criteria: BadReason[],
  // Optional bounds for the out_of_israel criterion. When that criterion is
  // requested, the geo filter is enabled (defaulting to DEFAULT_GEO_BOUNDS);
  // otherwise it stays off so no out-of-bounds point is flagged (gap G7).
  geoBounds?: GeoBounds,
): Promise<
  | { ok: true; scanned: number; deleted: number; perCriterion: Record<BadReason, number> }
  | { ok: false; error: string }
> {
  const geoFilter: GeoFilterOptions = criteria.includes("out_of_israel")
    ? { enabled: true, bounds: geoBounds }
    : { enabled: false };
  const scan = await scanBadGpsPoints(timeRange, geoFilter);
  if (!scan.ok) return scan;

  const wanted = new Set(criteria);
  const ids = new Set<string>();
  const perCriterion: Record<BadReason, number> = {
    accuracy: 0,
    speed: 0,
    place_drift: 0,
    out_of_israel: 0,
  };

  if (wanted.has("accuracy")) {
    perCriterion.accuracy = scan.result.badAccuracy.length;
    scan.result.badAccuracy.forEach((p) => ids.add(p.id));
  }
  if (wanted.has("speed")) {
    perCriterion.speed = scan.result.badSpeed.length;
    scan.result.badSpeed.forEach((p) => ids.add(p.id));
  }
  if (wanted.has("place_drift")) {
    perCriterion.place_drift = scan.result.badPlaceDrift.length;
    scan.result.badPlaceDrift.forEach((p) => ids.add(p.id));
  }
  if (wanted.has("out_of_israel")) {
    perCriterion.out_of_israel = scan.result.badOutOfIsrael.length;
    scan.result.badOutOfIsrael.forEach((p) => ids.add(p.id));
  }

  if (ids.size === 0) {
    return {
      ok: true,
      scanned: scan.result.totalScanned,
      deleted: 0,
      perCriterion,
    };
  }

  const del = await deleteGpsPoints([...ids]);
  if (!del.ok) return del;

  console.log(
    `[gps-cleanup] scanAndDelete range=${timeRange} criteria=[${criteria.join(",")}] ` +
      `geo_filter=${geoFilter.enabled ? "on" : "off"} deleted=${del.deleted}`,
  );

  return {
    ok: true,
    scanned: scan.result.totalScanned,
    deleted: del.deleted,
    perCriterion,
  };
}

export async function deleteGpsPoints(
  ids: string[],
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const userId = await getCurrentUserId();
  if (!userId) return { ok: false, error: "Not authenticated" };
  if (ids.length === 0) return { ok: true, deleted: 0 };

  const baseUrl = env.ELASTICSEARCH_URL;

  try {
    // Bulk delete. user_id scoping is enforced by refusing ids the user doesn't
    // own via a conditional delete_by_query on just those ids.
    const response = await fetch(`${baseUrl}/${INDEX}/_delete_by_query?refresh=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: {
          bool: {
            filter: [{ term: { user_id: userId } }, { ids: { values: ids } }],
          },
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, error: `ES delete failed: ${response.status} ${text}` };
    }
    const data = (await response.json()) as { deleted?: number };
    return { ok: true, deleted: data.deleted ?? 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
