/**
 * Stay-point (dwell) detection over a time-ordered list of GPS points.
 *
 * The rest of the awareness system only ever recognized PRE-DEFINED places
 * (a geo-match against ll5_knowledge_places). Raw GPS was never clustered into
 * "visits", so frequently-visited but unregistered locations were invisible.
 *
 * This module implements classic stay-point / dwell detection:
 *   A "visit" is a maximal run of consecutive points that all stay within
 *   STAY_RADIUS_M of the run's anchor (the run's first point), for at least
 *   MIN_DWELL_MS of wall-clock time. A time gap larger than MAX_GAP_MS between
 *   two consecutive points breaks the run (we assume the user moved away and
 *   the phone simply stopped reporting), as does a point that escapes the
 *   radius.
 *
 * It is a PURE function module: no I/O, no ES, no clock. That makes it fully
 * unit-testable and keeps the clustering logic independent of how points are
 * fetched. Callers (tools) inject the points.
 */
import { haversineDistance } from '../utils/geo.js';
import { logger } from '../utils/logger.js';

/** Maximum distance (meters) a point may sit from the run anchor and still
 * be considered part of the same dwell. */
export const STAY_RADIUS_M = 150;

/** Minimum wall-clock duration (ms) a run must span to count as a visit.
 * Shorter runs are pass-throughs, not dwells. Default: 10 minutes. */
export const MIN_DWELL_MS = 10 * 60 * 1000;

/** Maximum time gap (ms) allowed between two consecutive points before the
 * run is broken. Larger gaps imply the user left and the phone stopped
 * reporting. Default: 30 minutes. */
export const MAX_GAP_MS = 30 * 60 * 1000;

/** A single GPS observation fed into the clusterer. */
export interface StayPointInput {
  lat: number;
  lon: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Optional pre-resolved known place (propagated onto the visit if dominant). */
  matched_place_id?: string | null;
  matched_place?: string | null;
}

/** A detected dwell / visit. */
export interface Visit {
  centroid: { lat: number; lon: number };
  /** ISO 8601 start (first point of the run). */
  start: string;
  /** ISO 8601 end (last point of the run). */
  end: string;
  duration_minutes: number;
  point_count: number;
  /** Dominant matched place across the run, if any point was at a known place. */
  matched_place_id?: string;
  matched_place?: string;
}

export interface StayPointParams {
  stayRadiusM?: number;
  minDwellMs?: number;
  maxGapMs?: number;
}

function meanCentroid(points: StayPointInput[]): { lat: number; lon: number } {
  let sumLat = 0;
  let sumLon = 0;
  for (const p of points) {
    sumLat += p.lat;
    sumLon += p.lon;
  }
  return { lat: sumLat / points.length, lon: sumLon / points.length };
}

/**
 * Pick the dominant matched place across a run: the place that the most points
 * matched. Returns nothing if no point in the run had a matched place.
 */
function dominantPlace(
  points: StayPointInput[],
): { matched_place_id?: string; matched_place?: string } {
  const counts = new Map<string, { id?: string; name?: string; count: number }>();
  for (const p of points) {
    if (!p.matched_place_id && !p.matched_place) continue;
    // Key on id when present, otherwise on name, so unnamed-id matches still group.
    const key = p.matched_place_id ?? p.matched_place ?? '';
    if (!key) continue;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        id: p.matched_place_id ?? undefined,
        name: p.matched_place ?? undefined,
        count: 1,
      });
    }
  }
  if (counts.size === 0) return {};
  let best: { id?: string; name?: string; count: number } | undefined;
  for (const v of counts.values()) {
    if (!best || v.count > best.count) best = v;
  }
  return { matched_place_id: best?.id, matched_place: best?.name };
}

function buildVisit(run: StayPointInput[]): Visit {
  const centroid = meanCentroid(run);
  const start = run[0].timestamp;
  const end = run[run.length - 1].timestamp;
  const durationMs = new Date(end).getTime() - new Date(start).getTime();
  const place = dominantPlace(run);
  const visit: Visit = {
    centroid,
    start,
    end,
    duration_minutes: Math.round(durationMs / 60_000),
    point_count: run.length,
  };
  if (place.matched_place_id) visit.matched_place_id = place.matched_place_id;
  if (place.matched_place) visit.matched_place = place.matched_place;
  return visit;
}

/**
 * Detect stay-points / visits over a list of GPS points.
 *
 * Robust to: empty input, single point, points sorted descending (we sort
 * ascending internally), and points with identical timestamps. A run is
 * emitted as a visit only if its wall-clock span >= minDwellMs.
 */
export function detectStayPoints(
  points: StayPointInput[],
  params: StayPointParams = {},
): Visit[] {
  const stayRadiusM = params.stayRadiusM ?? STAY_RADIUS_M;
  const minDwellMs = params.minDwellMs ?? MIN_DWELL_MS;
  const maxGapMs = params.maxGapMs ?? MAX_GAP_MS;

  if (points.length === 0) {
    logger.debug('[stay-point-service][detectStayPoints] empty input');
    return [];
  }

  // Sort ascending by timestamp (input may arrive desc from ES). Stable enough
  // for identical timestamps — their relative order does not affect the result
  // since they share the same instant.
  const sorted = [...points].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const visits: Visit[] = [];
  let run: StayPointInput[] = [sorted[0]];
  let anchor = sorted[0];

  const flush = (): void => {
    const span = new Date(run[run.length - 1].timestamp).getTime() - new Date(run[0].timestamp).getTime();
    if (span >= minDwellMs) {
      visits.push(buildVisit(run));
    }
  };

  for (let i = 1; i < sorted.length; i++) {
    const point = sorted[i];
    const prev = sorted[i - 1];
    const gap = new Date(point.timestamp).getTime() - new Date(prev.timestamp).getTime();
    const dist = haversineDistance(anchor.lat, anchor.lon, point.lat, point.lon);

    if (gap > maxGapMs || dist > stayRadiusM) {
      // Run broken: either the user moved out of the radius, or reporting
      // lapsed long enough that we cannot assume continued presence.
      flush();
      run = [point];
      anchor = point;
    } else {
      run.push(point);
    }
  }
  flush();

  logger.debug('[stay-point-service][detectStayPoints] clustered', {
    points: sorted.length,
    visits: visits.length,
    stay_radius_m: stayRadiusM,
    min_dwell_ms: minDwellMs,
    max_gap_ms: maxGapMs,
  });

  return visits;
}

/** A frequent unknown location, aggregated across multiple visits. */
export interface FrequentPlaceCandidate {
  centroid: { lat: number; lon: number };
  visit_count: number;
  total_duration_minutes: number;
  first_seen: string;
  last_seen: string;
  sample_address?: string;
}

/**
 * Group visits whose centroids are near each other (within groupRadiusM,
 * defaulting to STAY_RADIUS_M) into frequent-place candidates. Greedy
 * single-pass clustering against the first member of each group's centroid —
 * good enough for surfacing recurring spots; not a full re-cluster.
 *
 * Does NOT apply the known-place exclusion or min_visits filter — callers
 * (the suggest_frequent_places tool) do that, because the exclusion needs ES.
 */
export function groupVisitsIntoCandidates(
  visits: Visit[],
  groupRadiusM: number = STAY_RADIUS_M,
): FrequentPlaceCandidate[] {
  const groups: Array<{ visits: Visit[]; anchor: { lat: number; lon: number } }> = [];

  for (const visit of visits) {
    let placed = false;
    for (const g of groups) {
      const d = haversineDistance(g.anchor.lat, g.anchor.lon, visit.centroid.lat, visit.centroid.lon);
      if (d <= groupRadiusM) {
        g.visits.push(visit);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ visits: [visit], anchor: { lat: visit.centroid.lat, lon: visit.centroid.lon } });
    }
  }

  return groups.map((g) => {
    const centroid = meanCentroid(
      g.visits.map((v) => ({ lat: v.centroid.lat, lon: v.centroid.lon, timestamp: v.start })),
    );
    const sortedByStart = [...g.visits].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );
    return {
      centroid,
      visit_count: g.visits.length,
      total_duration_minutes: g.visits.reduce((sum, v) => sum + v.duration_minutes, 0),
      first_seen: sortedByStart[0].start,
      last_seen: sortedByStart[sortedByStart.length - 1].end,
    };
  });
}
