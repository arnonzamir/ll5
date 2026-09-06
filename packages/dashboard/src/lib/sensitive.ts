/**
 * Sensitive-page catalog + step-up (identity re-validation) cookie.
 *
 * Pages listed in SENSITIVE_PATHS (prefix match) need, on top of the login
 * session, a fresh password confirmation: the middleware redirects to
 * /verify?next=<path> unless the `ll5_stepup` cookie is present and valid,
 * and every server action behind such a page calls requireStepUp() (see
 * step-up.ts) so data never loads through a direct action call either.
 *
 * Cookie value: `${exp}.${sig}` where exp is a unix-seconds expiry and
 * sig = base64url(HMAC-SHA256(AUTH_SECRET, `${userId}:${exp}`)). Binding the
 * signature to the user id means a cookie minted for one session cannot be
 * replayed for another user's session on the same browser.
 *
 * Everything here is pure and uses Web Crypto only, so the SAME code runs in
 * the edge middleware, in server actions and in unit tests. No next/* imports.
 */

/** Paths (prefix match) that require identity re-validation. Add a page here to make it sensitive. */
export const SENSITIVE_PATHS: string[] = ["/finance", "/settings/connectors"];

/** How long one password confirmation is good for. */
export const STEP_UP_TTL_SECONDS = 15 * 60;

export const STEP_UP_COOKIE = "ll5_stepup";

/** Where the middleware sends a session that has no valid step-up. */
export const VERIFY_PATH = "/verify";

export function isSensitivePath(pathname: string): boolean {
  return SENSITIVE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** The user id claim of an ll5 token payload (`uid`; `sub` accepted for compatibility). */
export function userIdFromPayload(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  const v = payload.uid ?? payload.sub;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function base64url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return base64url(sig);
}

/** Constant-time string equality (both strings are short base64url signatures). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint a step-up cookie value for `userId` expiring at `exp` (unix seconds). */
export async function signStepUp(userId: string, exp: number, secret: string): Promise<string> {
  if (!userId || !secret) throw new Error("signStepUp: userId and secret are required");
  const sig = await hmacSha256(secret, `${userId}:${exp}`);
  return `${exp}.${sig}`;
}

/**
 * True when `cookieValue` is a well-formed, unexpired step-up signed for
 * `userId` with `secret`. `now` is unix seconds. Never throws.
 */
export async function isStepUpValid(
  cookieValue: string | null | undefined,
  userId: string | null | undefined,
  secret: string | null | undefined,
  now: number,
): Promise<boolean> {
  if (!cookieValue || !userId || !secret) return false;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return false;
  const expStr = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (!/^\d{1,12}$/.test(expStr) || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return false;
  try {
    const expected = await hmacSha256(secret, `${userId}:${exp}`);
    return timingSafeEqual(sig, expected);
  } catch {
    return false;
  }
}

/**
 * Only allow same-origin relative paths as a post-verify destination:
 * must start with "/", not "//" (protocol-relative), no scheme, no
 * backslash tricks. Anything else falls back to /dashboard.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/^\/[^/?#]*:/.test(raw)) return fallback; // "/http:..." style scheme smuggling
  if (raw.startsWith(VERIFY_PATH)) return fallback; // never loop back onto /verify
  return raw;
}
