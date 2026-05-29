import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

// bcrypt.compare is slow; stub it to always reject so every attempt is a
// "failed" attempt (drives the rate limiter).
vi.mock('bcryptjs', () => ({
  default: {
    hashSync: vi.fn().mockReturnValue('$2a$12$decoyhashdecoyhashdecoyhash'),
    compare: vi.fn().mockResolvedValue(false),
  },
}));

const { createAuthRouter } = await import('../auth.js');

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';

function makeReq(body: Record<string, unknown>): Request {
  return { headers: {}, query: {}, body, params: {} } as unknown as Request;
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

/** Pool that always returns no user (so every attempt fails). */
function makePool(): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
}

function getHandler(router: ReturnType<typeof createAuthRouter>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return handlers[handlers.length - 1] as (req: Request, res: Response) => Promise<unknown>;
}

describe('auth rate limiter — case-insensitive key normalization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('treats differently-cased usernames as the SAME identity for rate limiting', async () => {
    const router = createAuthRouter(makePool(), AUTH_SECRET);
    const handler = getHandler(router, 'post', '/token');

    // 5 failed attempts as "Alice" should exhaust the 5-attempt window.
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await handler(makeReq({ username: 'Alice', pin: 'wrong' }), res);
      expect(res._status).toBe(401);
    }

    // The 6th attempt with a different CASE ("alice") must be rate-limited.
    // BUG: the limiter keys on the raw value, so 'alice' is a fresh bucket and
    // returns 401 (still allowed), defeating the per-identity limit.
    const res = makeRes();
    await handler(makeReq({ username: 'alice', pin: 'wrong' }), res);
    expect(res._status).toBe(429);
  });
});
