import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { PushLocationItem } from '../types/index.js';

// No geocoding, no known-place match by default — keeps tests focused on the
// plausibility/drift/accuracy logic and the stored doc shape.
vi.mock('../utils/geocoding.js', () => ({
  reverseGeocode: vi.fn(async () => null),
}));

import { processLocation, type StoredPoint } from '../processors/location.js';

const USER = 'user-loc-1';

interface IndexCall { index: string; document: Record<string, unknown> }

/**
 * ES mock: getPreviousLocation/search returns no prior point (empty), matchKnownPlace
 * returns no hits, and every index() call is captured.
 */
function makeEs(prevSource?: Record<string, unknown> | null): { es: Client; indexed: IndexCall[] } {
  const indexed: IndexCall[] = [];
  const es = {
    search: vi.fn(async (req: { index: string }) => {
      // getPreviousLocation reads ll5_awareness_locations sorted desc.
      if (req.index === 'll5_awareness_locations' && prevSource) {
        return { hits: { hits: [{ _source: prevSource }] } };
      }
      return { hits: { hits: [] } };
    }),
    index: vi.fn(async (req: { index: string; document: Record<string, unknown> }) => {
      indexed.push({ index: req.index, document: req.document });
      return { result: 'created' };
    }),
    get: vi.fn(async () => {
      throw { meta: { statusCode: 404 } };
    }),
  } as unknown as Client;
  return { es, indexed };
}

function loc(over: Partial<PushLocationItem>): PushLocationItem {
  return {
    type: 'location',
    timestamp: '2026-05-30T10:00:00.000Z',
    lat: 32.0,
    lon: 34.0,
    ...over,
  } as PushLocationItem;
}

function storedLocDocs(indexed: IndexCall[]): Record<string, unknown>[] {
  return indexed.filter((c) => c.index === 'll5_awareness_locations').map((c) => c.document);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processLocation — G3 device motion fields', () => {
  it('persists speed/bearing/altitude into the ES doc', async () => {
    const { es, indexed } = makeEs();
    await processLocation(es, USER, loc({ speed_mps: 12, bearing_deg: 90, altitude_m: 55 }), undefined, undefined, null);
    const docs = storedLocDocs(indexed);
    expect(docs).toHaveLength(1);
    expect(docs[0].speed).toBe(12);
    expect(docs[0].bearing).toBe(90);
    expect(docs[0].altitude).toBe(55);
  });
});

describe('processLocation — G9 low-accuracy handling', () => {
  it('stores a low-accuracy point flagged rather than dropping it', async () => {
    const { es, indexed } = makeEs();
    const stored = await processLocation(es, USER, loc({ accuracy_m: 500 }), undefined, undefined, null);
    const docs = storedLocDocs(indexed);
    expect(docs).toHaveLength(1);
    expect(docs[0].low_accuracy).toBe(true);
    expect(stored).not.toBeNull();
  });

  it('drops garbage accuracy (>2000m) entirely', async () => {
    const { es, indexed } = makeEs();
    const stored = await processLocation(es, USER, loc({ accuracy_m: 5000 }), undefined, undefined, null);
    expect(storedLocDocs(indexed)).toHaveLength(0);
    expect(stored).toBeNull();
  });

  it('does not flag a normal-accuracy point', async () => {
    const { es, indexed } = makeEs();
    await processLocation(es, USER, loc({ accuracy_m: 30 }), undefined, undefined, null);
    expect(storedLocDocs(indexed)[0].low_accuracy).toBeUndefined();
  });
});

describe('processLocation — G6 fast travel vs teleport', () => {
  const prev: StoredPoint = { lat: 32.0, lon: 34.0, timestamp: '2026-05-30T10:00:00.000Z' };
  // ~83km away, 2 minutes later → computed ~2500 km/h (implausible by raw speed).
  const farPoint = loc({ lat: 32.75, lon: 34.0, timestamp: '2026-05-30T10:02:00.000Z' });

  it('KEEPS a fast point when device speed confirms real travel', async () => {
    const { es, indexed } = makeEs();
    // Device reports ~2500 km/h?? No — keep it realistic: bring the points closer.
    // 5km in 2min = 150 km/h computed; device says 160 km/h → confirmed travel.
    const p = loc({ lat: 32.045, lon: 34.0, timestamp: '2026-05-30T10:02:00.000Z', speed_mps: 44 }); // ~158 km/h
    const stored = await processLocation(es, USER, p, undefined, undefined, prev);
    expect(storedLocDocs(indexed)).toHaveLength(1);
    expect(stored).not.toBeNull();
  });

  it('DROPS a teleport when device speed is zero/absent', async () => {
    const { es, indexed } = makeEs();
    const stored = await processLocation(es, USER, farPoint, undefined, undefined, prev);
    expect(storedLocDocs(indexed)).toHaveLength(0);
    expect(stored).toBeNull();
  });

  it('DROPS even device-confirmed motion above the absolute ceiling', async () => {
    const { es, indexed } = makeEs();
    // 83km in 2min ≈ 2490 km/h > 1000 ceiling; device claiming high speed cannot save it.
    const stored = await processLocation(es, USER, loc({ ...farPoint, speed_mps: 700 }), undefined, undefined, prev);
    expect(storedLocDocs(indexed)).toHaveLength(0);
    expect(stored).toBeNull();
  });
});

describe('processLocation — G1/G2 in-batch chaining', () => {
  it('returns the stored point so the caller can chain it', async () => {
    const { es } = makeEs();
    const stored = await processLocation(es, USER, loc({ lat: 32.0, lon: 34.0 }), undefined, undefined, null);
    expect(stored).toEqual({ lat: 32.0, lon: 34.0, timestamp: '2026-05-30T10:00:00.000Z', matched_place: undefined });
  });

  it('uses the passed prevPoint (not ES) for the drift check', async () => {
    // ES "latest" is a far-away stale point that, if used, would make the new
    // point look like a teleport. The in-batch prevPoint is right next door, so
    // the point must be kept — proving prevPoint takes precedence.
    const { es, indexed } = makeEs({ location: { lat: 0, lon: 0 }, timestamp: '2026-05-30T09:59:00.000Z' });
    const prev: StoredPoint = { lat: 32.0, lon: 34.0, timestamp: '2026-05-30T10:00:00.000Z' };
    const stored = await processLocation(
      es,
      USER,
      loc({ lat: 32.001, lon: 34.001, timestamp: '2026-05-30T10:01:00.000Z' }),
      undefined,
      undefined,
      prev,
    );
    expect(storedLocDocs(indexed)).toHaveLength(1);
    expect(stored).not.toBeNull();
  });

  it('skips the speed check on non-positive time delta but still stores', async () => {
    const { es, indexed } = makeEs();
    // prevPoint is AFTER the new point (out of order even post-sort / clock skew).
    const prev: StoredPoint = { lat: 32.0, lon: 34.0, timestamp: '2026-05-30T10:05:00.000Z' };
    const stored = await processLocation(
      es,
      USER,
      loc({ lat: 33.0, lon: 35.0, timestamp: '2026-05-30T10:00:00.000Z' }),
      undefined,
      undefined,
      prev,
    );
    expect(storedLocDocs(indexed)).toHaveLength(1);
    expect(stored).not.toBeNull();
  });
});
