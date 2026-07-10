import { describe, it, expect } from 'vitest';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { signConsoleToken, verifyConsoleToken, uidFromConsoleHost, registerConsoleRoutes } from '../console.js';

const SECRET = 'test-secret-key-at-least-32-characters-long!!';
const UID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';

describe('console token', () => {
  it('round-trips a valid token bound to the uid', () => {
    const tok = signConsoleToken(UID, SECRET, 3600, 1000);
    expect(verifyConsoleToken(tok, SECRET, 1001)).toEqual({ uid: UID });
  });

  it('rejects an expired token', () => {
    const tok = signConsoleToken(UID, SECRET, 60, 1000);
    expect(verifyConsoleToken(tok, SECRET, 1000 + 61)).toBeNull();
  });

  it('rejects a tampered payload / bad signature', () => {
    const tok = signConsoleToken(UID, SECRET, 3600, 1000);
    const forged = tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a');
    expect(verifyConsoleToken(forged, SECRET, 1001)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const tok = signConsoleToken(UID, SECRET, 3600, 1000);
    expect(verifyConsoleToken(tok, 'another-secret-key-at-least-32-characters', 1001)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifyConsoleToken(undefined, SECRET)).toBeNull();
    expect(verifyConsoleToken('', SECRET)).toBeNull();
    expect(verifyConsoleToken('c1.only-two', SECRET)).toBeNull();
    expect(verifyConsoleToken('x9.a.b', SECRET)).toBeNull();
  });
});

// Pull the /internal/console-auth handler out of the router and invoke it with
// a mock req/res so we can assert the forwardAuth 302/200/401 behavior.
function consoleAuthHandler() {
  const router = Router();
  registerConsoleRoutes(router, SECRET);
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack
    .find((l) => l.route?.path === '/internal/console-auth' && l.route?.methods['get']);
  if (!layer?.route) throw new Error('route not found');
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: Request, res: Response) => void;
}
function mockRes() {
  const res: Record<string, unknown> = {
    _status: 200, _headers: {} as Record<string, string>, _redirect: null as string | null,
    status(c: number) { this._status = c; return this; },
    setHeader(k: string, v: string) { (this._headers as Record<string, string>)[k] = v; },
    send() { return this; },
    redirect(code: number, url: string) { this._status = code; this._redirect = url; return this; },
  };
  return res as unknown as Response & { _status: number; _headers: Record<string, string>; _redirect: string | null };
}

describe('/internal/console-auth forwardAuth', () => {
  const handler = consoleAuthHandler();
  const HOST = `agent-${UID}.noninoni.click`;

  it('302s + Set-Cookie on a valid query token (first hit)', () => {
    const tok = signConsoleToken(UID, SECRET);
    const req = { headers: { 'x-forwarded-host': HOST, 'x-forwarded-uri': `/?ll5_console_token=${tok}`, 'x-forwarded-proto': 'https' } } as unknown as Request;
    const res = mockRes();
    handler(req, res);
    expect(res._status).toBe(302);
    expect(res._redirect).toBe(`https://${HOST}/`); // token stripped
    expect(res._headers['Set-Cookie']).toContain('ll5_console=');
    expect(res._headers['Set-Cookie']).toContain('HttpOnly');
  });

  it('200s on a valid cookie (steady state)', () => {
    const tok = signConsoleToken(UID, SECRET);
    const req = { headers: { 'x-forwarded-host': HOST, 'x-forwarded-uri': '/assets/x.js', cookie: `ll5_console=${tok}` } } as unknown as Request;
    const res = mockRes();
    handler(req, res);
    expect(res._status).toBe(200);
  });

  it('401s with no token', () => {
    const req = { headers: { 'x-forwarded-host': HOST, 'x-forwarded-uri': '/' } } as unknown as Request;
    const res = mockRes();
    handler(req, res);
    expect(res._status).toBe(401);
  });

  it('401s when the token uid does not match the host', () => {
    const tok = signConsoleToken('some-other-uid', SECRET);
    const req = { headers: { 'x-forwarded-host': HOST, 'x-forwarded-uri': `/?ll5_console_token=${tok}` } } as unknown as Request;
    const res = mockRes();
    handler(req, res);
    expect(res._status).toBe(401);
  });
});

describe('uidFromConsoleHost', () => {
  it('extracts the uuid from agent-<uid>.<base>', () => {
    expect(uidFromConsoleHost(`agent-${UID}.noninoni.click`)).toBe(UID);
  });
  it('returns null for non-console hosts', () => {
    expect(uidFromConsoleHost('ll5.noninoni.click')).toBeNull();
    expect(uidFromConsoleHost(undefined)).toBeNull();
    expect(uidFromConsoleHost('agent-.noninoni.click')).toBeNull();
  });
});
