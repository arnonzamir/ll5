"use server";

import { env } from "@/lib/env";
import { getToken, decodeTokenPayload } from "@/lib/auth";

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

export interface BadPoint {
  id: string;
  timestamp: string;
  lat: number;
  lon: number;
  accuracy?: number;
  matched_place?: string;
  reason: "accuracy" | "speed" | "place_drift";
  detail: string;
}

export interface GpsScanResult {
  totalScanned: number;
  badAccuracy: BadPoint[];
  badSpeed: BadPoint[];
  badPlaceDrift: BadPoint[];
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

async function fetchAllPoints(userId: string): Promise<LocHit[]> {
  const baseUrl = env.ELASTICSEARCH_URL;
  const points: LocHit[] = [];
  let searchAfter: unknown[] | null = null;
  const PAGE = 1000;

  while (true) {
    const body: Record<string, unknown> = {
      size: PAGE,
      query: { term: { user_id: userId } },
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

export async function scanBadGpsPoints(): Promise<
  { ok: true; result: GpsScanResult } | { ok: false; error: string }
> {
  const userId = await getCurrentUserId();
  if (!userId) return { ok: false, error: "Not authenticated" };

  try {
    const points = await fetchAllPoints(userId);
    const badAccuracy: BadPoint[] = [];
    const badSpeed: BadPoint[] = [];
    const badPlaceDrift: BadPoint[] = [];

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
      ]),
    );

    return {
      ok: true,
      result: {
        totalScanned: points.length,
        badAccuracy,
        badSpeed,
        badPlaceDrift,
        uniqueBadIds,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
