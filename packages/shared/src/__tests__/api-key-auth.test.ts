import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { extractUserContext } from '../auth/api-key.js';
import { tokenAuthMiddleware } from '../auth/middleware.js';
import type { AuthConfig } from '../auth/types.js';
import { AuthError } from '../utils/errors.js';

const API_KEY = 'super-secret-api-key-value-1234567890';
const USER_ID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';
const AUTH_SECRET = 'test-secret-for-auth-testing-abcdef1234567890';

const config: AuthConfig = { apiKey: API_KEY, userId: USER_ID };

// ---------------------------------------------------------------------------
// extractUserContext (api-key.ts)
// ---------------------------------------------------------------------------

describe('extractUserContext (API key)', () => {
  it('accepts the correct key and returns the user context', () => {
    const ctx = extractUserContext(`Bearer ${API_KEY}`, config);
    expect(ctx.userId).toBe(USER_ID);
  });

  it('rejects a wrong key of the same length', () => {
    const wrong = 'x'.repeat(API_KEY.length);
    expect(() => extractUserContext(`Bearer ${wrong}`, config)).toThrow(AuthError);
  });

  it('rejects a wrong key of a different length safely (no throw from compare)', () => {
    // A length mismatch must be rejected as an AuthError — never a raw crash
    // from timingSafeEqual on unequal buffer lengths.
    expect(() => extractUserContext('Bearer short', config)).toThrow(AuthError);
    expect(() => extractUserContext(`Bearer ${API_KEY}EXTRA`, config)).toThrow(AuthError);
  });

  it('uses a constant-time comparison primitive', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    try {
      // Same-length wrong key reaches the constant-time compare.
      const wrong = 'x'.repeat(API_KEY.length);
      expect(() => extractUserContext(`Bearer ${wrong}`, config)).toThrow(AuthError);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects missing/malformed headers', () => {
    expect(() => extractUserContext(undefined, config)).toThrow(AuthError);
    expect(() => extractUserContext('Basic abc', config)).toThrow(AuthError);
  });
});

// ---------------------------------------------------------------------------
// tokenAuthMiddleware legacy API key fallback (middleware.ts)
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('tokenAuthMiddleware legacy API key fallback', () => {
  const mwConfig = { authSecret: AUTH_SECRET, legacy: config };

  it('accepts the correct legacy key and sets userId', () => {
    const mw = tokenAuthMiddleware(mwConfig);
    const req = { headers: { authorization: `Bearer ${API_KEY}` } } as never;
    const res = makeRes();
    const next = vi.fn();

    mw(req as never, res as never, next as never);

    expect(next).toHaveBeenCalledOnce();
    expect((req as { userId?: string }).userId).toBe(USER_ID);
  });

  it('rejects a wrong same-length legacy key with 401', () => {
    const mw = tokenAuthMiddleware(mwConfig);
    const wrong = 'x'.repeat(API_KEY.length);
    const req = { headers: { authorization: `Bearer ${wrong}` } } as never;
    const res = makeRes();
    const next = vi.fn();

    mw(req as never, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a different-length legacy key safely (no crash) with 401', () => {
    const mw = tokenAuthMiddleware(mwConfig);
    const req = { headers: { authorization: 'Bearer short' } } as never;
    const res = makeRes();
    const next = vi.fn();

    expect(() => mw(req as never, res as never, next as never)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('uses a constant-time comparison for the legacy key', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    try {
      const mw = tokenAuthMiddleware(mwConfig);
      const wrong = 'x'.repeat(API_KEY.length);
      const req = { headers: { authorization: `Bearer ${wrong}` } } as never;
      const res = makeRes();
      mw(req as never, res as never, (() => {}) as never);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
