import { describe, it, expect } from 'vitest';
import {
  detectStayPoints,
  groupVisitsIntoCandidates,
  STAY_RADIUS_M,
  MIN_DWELL_MS,
  MAX_GAP_MS,
  type StayPointInput,
  type Visit,
} from '../services/stay-point-service.js';

// A fixed anchor in Tel Aviv. Offsets below stay well within / outside the
// STAY_RADIUS_M (150m) budget.
const LAT = 32.0853;
const LON = 34.7818;

// ~1 deg latitude ≈ 111_000m, so 0.001 deg ≈ 111m (inside radius),
// 0.01 deg ≈ 1.1km (well outside radius).
const NEAR_DLAT = 0.0005; // ~55m
const FAR_DLAT = 0.01; // ~1.1km

function p(
  minutesFromBase: number,
  opts: Partial<StayPointInput> = {},
): StayPointInput {
  const base = new Date('2026-05-01T08:00:00Z').getTime();
  return {
    lat: LAT,
    lon: LON,
    timestamp: new Date(base + minutesFromBase * 60_000).toISOString(),
    ...opts,
  };
}

describe('detectStayPoints — edge inputs', () => {
  it('returns [] for empty input', () => {
    expect(detectStayPoints([])).toEqual([]);
  });

  it('returns [] for a single point (no span)', () => {
    expect(detectStayPoints([p(0)])).toEqual([]);
  });
});

describe('detectStayPoints — dwell rule', () => {
  it('a long dwell (well past MIN_DWELL) is one visit with correct duration/centroid/point_count', () => {
    // 4 points over 30 minutes, all within radius.
    const pts: StayPointInput[] = [
      p(0, { lat: LAT }),
      p(10, { lat: LAT + NEAR_DLAT }),
      p(20, { lat: LAT - NEAR_DLAT }),
      p(30, { lat: LAT }),
    ];
    const visits = detectStayPoints(pts);
    expect(visits).toHaveLength(1);
    const v = visits[0];
    expect(v.point_count).toBe(4);
    expect(v.duration_minutes).toBe(30);
    expect(v.start).toBe(pts[0].timestamp);
    expect(v.end).toBe(pts[3].timestamp);
    // Centroid is the mean; lon constant, lat near anchor.
    expect(v.centroid.lon).toBeCloseTo(LON, 6);
    expect(v.centroid.lat).toBeCloseTo(LAT, 4);
  });

  it('two close points spanning < MIN_DWELL produce no visit (pass-through)', () => {
    const pts = [p(0, { lat: LAT }), p(5, { lat: LAT + NEAR_DLAT })];
    expect(detectStayPoints(pts)).toEqual([]);
  });

  it('two far-apart points produce no visit (each run is a single point, no span)', () => {
    const pts = [p(0, { lat: LAT }), p(15, { lat: LAT + FAR_DLAT })];
    expect(detectStayPoints(pts)).toEqual([]);
  });

  it('respects override params (shorter min dwell yields a visit)', () => {
    const pts = [p(0, { lat: LAT }), p(5, { lat: LAT + NEAR_DLAT })];
    const visits = detectStayPoints(pts, { minDwellMs: 4 * 60_000 });
    expect(visits).toHaveLength(1);
    expect(visits[0].duration_minutes).toBe(5);
  });
});

describe('detectStayPoints — splitting', () => {
  it('moving out of the radius splits into separate runs', () => {
    const pts = [
      // Dwell A: 0..20 min at anchor
      p(0, { lat: LAT }),
      p(20, { lat: LAT + NEAR_DLAT }),
      // Jump far away, then dwell B: 25..50 min
      p(25, { lat: LAT + FAR_DLAT }),
      p(50, { lat: LAT + FAR_DLAT + NEAR_DLAT }),
    ];
    const visits = detectStayPoints(pts);
    expect(visits).toHaveLength(2);
    expect(visits[0].duration_minutes).toBe(20);
    expect(visits[1].duration_minutes).toBe(25);
  });

  it('a gap exceeding MAX_GAP_MS splits visits even within the radius', () => {
    const pts = [
      p(0, { lat: LAT }),
      p(15, { lat: LAT + NEAR_DLAT }),
      // 40-minute gap (> 30 min MAX_GAP) at the same spot
      p(55, { lat: LAT }),
      p(75, { lat: LAT + NEAR_DLAT }),
    ];
    const visits = detectStayPoints(pts);
    expect(visits).toHaveLength(2);
    expect(visits[0].duration_minutes).toBe(15);
    expect(visits[1].duration_minutes).toBe(20);
  });
});

describe('detectStayPoints — robustness', () => {
  it('sorts descending input ascending internally', () => {
    const asc = [p(0, { lat: LAT }), p(10, { lat: LAT + NEAR_DLAT }), p(20, { lat: LAT })];
    const desc = [...asc].reverse();
    const visits = detectStayPoints(desc);
    expect(visits).toHaveLength(1);
    expect(visits[0].start).toBe(asc[0].timestamp);
    expect(visits[0].end).toBe(asc[2].timestamp);
    expect(visits[0].point_count).toBe(3);
  });

  it('handles identical timestamps (zero-span run is not a visit on its own)', () => {
    const ts = '2026-05-01T08:00:00Z';
    const pts: StayPointInput[] = [
      { lat: LAT, lon: LON, timestamp: ts },
      { lat: LAT + NEAR_DLAT, lon: LON, timestamp: ts },
      { lat: LAT, lon: LON, timestamp: ts },
    ];
    // All same instant -> span 0 -> below MIN_DWELL -> no visit, no crash.
    expect(detectStayPoints(pts)).toEqual([]);
  });

  it('identical timestamps within a longer dwell still count as points', () => {
    const dup = '2026-05-01T08:05:00Z';
    const pts: StayPointInput[] = [
      p(0, { lat: LAT }),
      { lat: LAT, lon: LON, timestamp: dup },
      { lat: LAT + NEAR_DLAT, lon: LON, timestamp: dup },
      p(20, { lat: LAT }),
    ];
    const visits = detectStayPoints(pts);
    expect(visits).toHaveLength(1);
    expect(visits[0].point_count).toBe(4);
    expect(visits[0].duration_minutes).toBe(20);
  });
});

describe('detectStayPoints — matched-place propagation', () => {
  it('propagates the dominant matched place onto the visit', () => {
    const pts: StayPointInput[] = [
      p(0, { lat: LAT, matched_place_id: 'home', matched_place: 'Home' }),
      p(10, { lat: LAT + NEAR_DLAT, matched_place_id: 'home', matched_place: 'Home' }),
      p(20, { lat: LAT, matched_place_id: 'gym', matched_place: 'Gym' }),
    ];
    const visits = detectStayPoints(pts);
    expect(visits).toHaveLength(1);
    expect(visits[0].matched_place_id).toBe('home');
    expect(visits[0].matched_place).toBe('Home');
  });

  it('leaves matched place undefined when no point matched', () => {
    const pts = [p(0, { lat: LAT }), p(10, { lat: LAT + NEAR_DLAT }), p(20, { lat: LAT })];
    const visits = detectStayPoints(pts);
    expect(visits[0].matched_place_id).toBeUndefined();
    expect(visits[0].matched_place).toBeUndefined();
  });
});

describe('constants are sane defaults', () => {
  it('exposes documented defaults', () => {
    expect(STAY_RADIUS_M).toBe(150);
    expect(MIN_DWELL_MS).toBe(10 * 60 * 1000);
    expect(MAX_GAP_MS).toBe(30 * 60 * 1000);
  });
});

describe('groupVisitsIntoCandidates', () => {
  function visit(lat: number, startMin: number, durationMin: number): Visit {
    const base = new Date('2026-05-01T08:00:00Z').getTime();
    const start = new Date(base + startMin * 60_000).toISOString();
    const end = new Date(base + (startMin + durationMin) * 60_000).toISOString();
    return {
      centroid: { lat, lon: LON },
      start,
      end,
      duration_minutes: durationMin,
      point_count: 3,
    };
  }

  it('groups nearby visits and aggregates counts/durations/seen times', () => {
    const visits = [
      visit(LAT, 0, 30),
      visit(LAT + NEAR_DLAT, 60, 20),
      visit(LAT + FAR_DLAT, 120, 40), // far away -> separate group
    ];
    const groups = groupVisitsIntoCandidates(visits);
    expect(groups).toHaveLength(2);
    const big = groups.find((g) => g.visit_count === 2)!;
    expect(big.visit_count).toBe(2);
    expect(big.total_duration_minutes).toBe(50);
    expect(big.first_seen).toBe(visits[0].start);
    expect(big.last_seen).toBe(visits[1].end);
  });
});
