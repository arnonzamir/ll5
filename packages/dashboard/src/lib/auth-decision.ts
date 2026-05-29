/**
 * Pure decision logic for the auth middleware's token-lifecycle handling.
 *
 * Kept dependency-free (no next/server, no fetch) so it is trivially
 * unit-testable. The middleware wires the I/O (cookie read/write, refresh
 * fetch, redirects) around the decision this returns.
 */

/** Refresh the token when it has less than this many seconds of life left. */
export const REFRESH_WINDOW_SECONDS = 2 * 24 * 60 * 60; // 2 days

/**
 * The gateway grants a grace period past `exp` on /auth/refresh
 * (REFRESH_GRACE_PERIOD_DAYS in packages/gateway/src/auth.ts). A token that is
 * expired but still within this window can be refreshed without a PIN. Beyond
 * it, the gateway forces a re-login — so the dashboard must not even attempt a
 * refresh.
 */
export const REFRESH_GRACE_SECONDS = 7 * 24 * 60 * 60; // 7 days

export type TokenAction =
  | "pass" // valid and not near expiry — serve as-is
  | "refresh" // near expiry, or expired-but-within-grace — try /auth/refresh
  | "reauth"; // expired beyond grace, or malformed (no exp) — force /login

/**
 * Decide what the middleware should do for a token, given how many seconds of
 * life it has left and whether it carried a usable `exp` claim at all.
 *
 * Branches (mutually exclusive, in priority order):
 *   - hasExp === false        → reauth   (malformed/legacy token; never refresh-spam)
 *   - secondsLeft <= -grace   → reauth   (expired beyond the gateway grace window)
 *   - secondsLeft < refreshWin→ refresh  (near expiry OR expired-but-within-grace)
 *   - otherwise               → pass     (comfortably valid)
 */
export function decideTokenAction(
  secondsLeft: number,
  hasExp: boolean,
  refreshWindowSeconds: number = REFRESH_WINDOW_SECONDS,
  graceSeconds: number = REFRESH_GRACE_SECONDS,
): TokenAction {
  // A token with no `exp` claim decodes to secondsLeft = -now (hugely
  // negative), which would otherwise look "expired beyond grace" and, before
  // the grace clamp existed, triggered a refresh attempt on every request.
  // Treat it as reauth explicitly — never spam the refresh endpoint.
  if (!hasExp) return "reauth";

  if (secondsLeft <= -graceSeconds) return "reauth";
  if (secondsLeft < refreshWindowSeconds) return "refresh";
  return "pass";
}
