// Per-user opencode console access. The console is served at
// `agent-<uid>.<CONSOLE_DOMAIN_BASE>` (Traefik → the user's container :4096).
// A Traefik forwardAuth middleware calls /internal/console-auth on every request;
// we 200 only when a valid console token (bound to that uid) is present — as a
// query param on the first hit (which we convert into an HttpOnly cookie) or as
// the cookie on subsequent requests. The token is minted by /me/agent/console/enter,
// which is itself behind the tenant's LL5 token — so the console is gated by the
// tenant key end to end. The opencode server is never exposed unauthenticated.

import type { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { chatAuthMiddleware } from './chat.js';
import { logger } from './utils/logger.js';

const CONSOLE_COOKIE = 'll5_console';
const CONSOLE_TTL_SEC = 8 * 60 * 60; // 8h console session

/** Sign a console-scoped token bound to a uid. Format `c1.<payloadB64url>.<hmac>`. */
export function signConsoleToken(
  uid: string,
  secret: string,
  ttlSec = CONSOLE_TTL_SEC,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp: nowSec + ttlSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update('console.' + payload).digest('hex').slice(0, 32);
  return `c1.${payload}.${sig}`;
}

/** Verify a console token; returns `{ uid }` when valid+unexpired, else null. */
export function verifyConsoleToken(
  token: string | undefined | null,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): { uid: string } | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'c1') return null;
  const [, payload, sig] = parts;
  const expect = crypto.createHmac('sha256', secret).update('console.' + payload).digest('hex').slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { uid?: unknown; exp?: unknown };
    if (typeof obj.uid !== 'string' || typeof obj.exp !== 'number') return null;
    if (nowSec >= obj.exp) return null;
    return { uid: obj.uid };
  } catch {
    return null;
  }
}

/** Extract the uid from a console host `agent-<uid>.<base>` (uid is a uuid, no dots). */
export function uidFromConsoleHost(host: string | undefined): string | null {
  if (!host) return null;
  const m = /^agent-([0-9a-fA-F-]+)\./.exec(host.trim());
  return m ? m[1] : null;
}

/** Read a named cookie from a raw Cookie header. */
function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * Register the console routes on the (root-mounted) agent router.
 *  - GET /me/agent/console/enter  (tenant-LL5-token auth) → { url } to open.
 *  - GET /internal/console-auth   (Traefik forwardAuth; NOT user-authed) → 200/401.
 */
export function registerConsoleRoutes(router: Router, authSecret: string): void {
  const authMw = chatAuthMiddleware(authSecret);

  router.get('/me/agent/console/enter', authMw, (req: Request, res: Response) => {
    const base = process.env.CONSOLE_DOMAIN_BASE;
    if (!base) {
      res.status(503).json({ error: 'Console is not enabled' });
      return;
    }
    const userId = (req as Request & { userId: string }).userId;
    const token = signConsoleToken(userId, authSecret);
    const url = `https://agent-${userId}.${base}/?ll5_console_token=${encodeURIComponent(token)}`;
    res.json({ url });
  });

  router.get('/internal/console-auth', (req: Request, res: Response) => {
    // Traefik forwards the ORIGINAL request context via X-Forwarded-* + Cookie.
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? undefined;
    const hostUid = uidFromConsoleHost(host);
    if (!hostUid) {
      res.status(401).send('bad host');
      return;
    }

    // Token from the cookie (steady state) or the ?ll5_console_token query (first hit).
    const cookieTok = cookieValue(req.headers['cookie'] as string | undefined, CONSOLE_COOKIE);
    const fwdUri = (req.headers['x-forwarded-uri'] as string | undefined) ?? '';
    let queryTok: string | undefined;
    try {
      queryTok = new URL(fwdUri, 'http://x').searchParams.get('ll5_console_token') ?? undefined;
    } catch {
      queryTok = undefined;
    }

    const fromCookie = verifyConsoleToken(cookieTok, authSecret);
    if (fromCookie && fromCookie.uid === hostUid) {
      res.status(200).send('ok');
      return;
    }
    const fromQuery = verifyConsoleToken(queryTok, authSecret);
    if (fromQuery && fromQuery.uid === hostUid) {
      // First hit: plant the token as an HttpOnly cookie and REDIRECT to the
      // token-stripped URL. This must be a 302 (a non-2xx): Traefik forwardAuth
      // returns non-2xx auth responses — headers + all — straight to the CLIENT,
      // so the Set-Cookie reaches the browser. (On a 2xx, Traefik would only copy
      // authResponseHeaders onto the UPSTREAM request, never to the client, which
      // is why a "200 + Set-Cookie" here never planted the cookie.) The browser
      // sets the cookie, follows the redirect, and the cookie branch above then
      // authenticates every subsequent SPA asset/API/SSE request.
      const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
      let cleanUri = '/';
      try {
        const u = new URL(fwdUri, 'http://x');
        u.searchParams.delete('ll5_console_token');
        cleanUri = u.pathname + (u.search || '');
      } catch {
        cleanUri = '/';
      }
      res.setHeader(
        'Set-Cookie',
        `${CONSOLE_COOKIE}=${queryTok}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${CONSOLE_TTL_SEC}`,
      );
      res.redirect(302, `${proto}://${host}${cleanUri}`);
      return;
    }

    logger.warn('[console-auth] denied', { host, hasCookie: !!cookieTok, hasQuery: !!queryTok });
    res.status(401).send('unauthorized');
  });
}
