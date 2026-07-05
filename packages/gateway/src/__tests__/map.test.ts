import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';

vi.mock('@ll5/shared', async (orig) => {
  const actual = await orig<typeof import('@ll5/shared')>();
  return { ...actual, logAudit: vi.fn() };
});

import { createMapRouter, downsampleTrail, TRAIL_MAX_POINTS } from '../map.js';

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';

function userToken(userId: string, role = 'user'): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid: userId, role, iat: now, exp: now + 30 * 86400 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex').slice(0, 32);
  return `ll5.${payloadB64}.${signature}`;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, query: {}, body: {}, params: {}, ...overrides } as unknown as Request;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res: any = {
    _status: 200,
    _json: null,
    status(code: number) { this._status = code; return this; },
    json(data: unknown) { this._json = data; return this; },
  };
  return res;
}

function makePool(homeTz = 'UTC'): Pool {
  const run = async (sql: string) =>
    /settings->>'current_timezone'/.test(sql)
      ? { rows: [{ current_tz: null, current_tz_at: null, home_tz: homeTz }] }
      : { rows: [] };
  return { query: vi.fn(run) } as unknown as Pool;
}

/** ES mock routing per index — the map hits three indices in one request. */
function makeEs(byIndex: Record<string, unknown[] | (() => never)>): { es: Client; search: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async (params: { index: string }) => {
    const entry = byIndex[params.index];
    if (typeof entry === 'function') entry();
    return { hits: { hits: entry ?? [] } };
  });
  return { es: { search } as unknown as Client, search };
}

function getChain(router: ReturnType<typeof createMapRouter>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return async (req: Request, res: Response) => {
    for (let i = 0; i < handlers.length; i++) {
      let advanced = false;
      const next = () => { advanced = true; };
      await handlers[i](req, res, next);
      if (!advanced) return;
    }
  };
}

const NOW = () => new Date('2026-07-05T08:30:00Z');

async function runMap(pool: Pool, es: Client, now: () => Date = NOW, token: string | null = userToken('u1')) {
  const router = createMapRouter(pool, es, AUTH_SECRET, { now });
  const run = getChain(router, 'get', '/me/map');
  const req = makeReq({ headers: token ? { authorization: `Bearer ${token}` } : {} });
  const res = makeRes();
  await run(req, res);
  return res;
}

const DEVICES = 'll5_awareness_tracked_devices';
const PLACES = 'll5_knowledge_places';
const LOCATIONS = 'll5_awareness_locations';

// ---------------------------------------------------------------------------
// downsampleTrail (pure)
// ---------------------------------------------------------------------------

describe('downsampleTrail', () => {
  const points = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

  it('passes small trails through untouched', () => {
    const p = points(150);
    expect(downsampleTrail(p)).toBe(p);
  });

  it('downsamples every Nth to ≤200, keeping the first and last points, order preserved', () => {
    const p = points(1000); // stride 5
    const out = downsampleTrail(p);
    expect(out.length).toBeLessThanOrEqual(TRAIL_MAX_POINTS);
    expect(out[0]).toEqual({ i: 0 });
    expect(out[out.length - 1]).toEqual({ i: 999 });
    for (let k = 1; k < out.length; k++) {
      expect((out[k] as any).i).toBeGreaterThan((out[k - 1] as any).i);
    }
    // Every Nth: interior samples are stride-spaced.
    expect((out[1] as any).i).toBe(5);
    expect((out[2] as any).i).toBe(10);
  });

  it('handles non-divisible sizes (201 points → ≤200 with last kept)', () => {
    const out = downsampleTrail(points(201)); // stride 2 → 101 samples
    expect(out.length).toBeLessThanOrEqual(TRAIL_MAX_POINTS);
    expect(out[out.length - 1]).toEqual({ i: 200 });
  });

  it('replaces the final sample with the true last point when already at the cap', () => {
    const out = downsampleTrail(points(400)); // stride 2 → exactly 200 samples ending at 398
    expect(out.length).toBe(TRAIL_MAX_POINTS);
    expect(out[out.length - 1]).toEqual({ i: 399 });
  });
});

// ---------------------------------------------------------------------------
// GET /me/map
// ---------------------------------------------------------------------------

describe('GET /me/map', () => {
  it('401s without a token', async () => {
    const { es } = makeEs({});
    const res = await runMap(makePool(), es, NOW, null);
    expect(res._status).toBe(401);
  });

  it('aggregates devices + places + today trail with the frozen shapes', async () => {
    const { es, search } = makeEs({
      [DEVICES]: [
        { _source: { name: 'Pixel 9', location: { lat: 32.08, lon: 34.78 }, last_seen: '2026-07-05T08:10:00Z' } },
        { _source: { name: 'Keys tag', location: { lat: 32.09, lon: 34.79 }, last_seen: '2026-07-05T06:00:00Z' } },
        // No fix yet → filtered out, never a null island.
        { _source: { name: 'Bag tag', last_seen: '2026-07-01T00:00:00Z' } },
      ],
      [PLACES]: [
        { _source: { name: 'Home', geo: { lat: 32.07, lon: 34.77 }, radius_m: 150 } },
        { _source: { name: 'Office', geo: { lat: 32.06, lon: 34.76 } } }, // no radius → default 100
      ],
      [LOCATIONS]: [
        { _source: { location: { lat: 32.05, lon: 34.75 }, timestamp: '2026-07-05T07:00:00Z' } },
        { _source: { location: { lat: 32.06, lon: 34.76 }, timestamp: '2026-07-05T08:00:00Z' } },
      ],
    });

    const res = await runMap(makePool(), es);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      devices: [
        { name: 'Pixel 9', lat: 32.08, lon: 34.78, seen_at: '2026-07-05T08:10:00.000Z' },
        { name: 'Keys tag', lat: 32.09, lon: 34.79, seen_at: '2026-07-05T06:00:00.000Z' },
      ],
      places: [
        { name: 'Home', lat: 32.07, lon: 34.77, radius_m: 150 },
        { name: 'Office', lat: 32.06, lon: 34.76, radius_m: 100 },
      ],
      trail_today: [
        { lat: 32.05, lon: 34.75, ts: '2026-07-05T07:00:00.000Z' },
        { lat: 32.06, lon: 34.76, ts: '2026-07-05T08:00:00.000Z' },
      ],
    });

    // All three sections user-scoped.
    for (const call of search.mock.calls) {
      const q = call[0] as any;
      expect(JSON.stringify(q.query)).toContain('"user_id":"u1"');
    }
  });

  it("bounds the trail to TODAY in the user's effective tz and excludes suspect fixes", async () => {
    const { es, search } = makeEs({ [DEVICES]: [], [PLACES]: [], [LOCATIONS]: [] });
    await runMap(makePool('Asia/Jerusalem'), es); // 08:30Z, local day starts 2026-07-04T21:00Z

    const trailQ = (search.mock.calls.find((c) => (c[0] as any).index === LOCATIONS)![0] as any);
    expect(trailQ.sort).toEqual([{ timestamp: 'asc' }]);
    expect(trailQ.query.bool.filter).toEqual([
      { term: { user_id: 'u1' } },
      { range: { timestamp: { gte: '2026-07-04T21:00:00.000Z', lt: '2026-07-05T21:00:00.000Z' } } },
    ]);
    expect(trailQ.query.bool.must_not).toEqual([{ term: { suspect: true } }]);
  });

  it('downsamples a dense day to ≤200 points, oldest first', async () => {
    const dense = Array.from({ length: 1440 }, (_, i) => ({
      _source: {
        location: { lat: 32 + i * 1e-4, lon: 34 + i * 1e-4 },
        timestamp: new Date(Date.UTC(2026, 6, 5, 0, 0, i * 30)).toISOString(),
      },
    }));
    const { es } = makeEs({ [DEVICES]: [], [PLACES]: [], [LOCATIONS]: dense });

    const res = await runMap(makePool(), es);
    const trail = (res._json as any).trail_today;
    expect(trail.length).toBeLessThanOrEqual(200);
    expect(trail[0].ts).toBe('2026-07-05T00:00:00.000Z');
    expect(trail[trail.length - 1].ts).toBe(new Date(Date.UTC(2026, 6, 5, 0, 0, 1439 * 30)).toISOString());
    for (let k = 1; k < trail.length; k++) {
      expect(trail[k].ts > trail[k - 1].ts).toBe(true);
    }
  });

  it('degrades a missing index to an empty section (per-section, others still served)', async () => {
    const { es } = makeEs({
      [DEVICES]: () => { throw new Error('index_not_found_exception: no such index [ll5_awareness_tracked_devices]'); },
      [PLACES]: [{ _source: { name: 'Home', geo: { lat: 32.07, lon: 34.77 }, radius_m: 150 } }],
      [LOCATIONS]: [],
    });
    const res = await runMap(makePool(), es);
    expect(res._status).toBe(200);
    const body = res._json as any;
    expect(body.devices).toEqual([]);
    expect(body.places).toHaveLength(1);
  });

  it('500s on a real ES failure — no silent defaults', async () => {
    const { es } = makeEs({
      [DEVICES]: () => { throw new Error('connection refused'); },
      [PLACES]: [],
      [LOCATIONS]: [],
    });
    const res = await runMap(makePool(), es);
    expect(res._status).toBe(500);
  });
});
