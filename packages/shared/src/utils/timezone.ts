/**
 * Timezone resolution for a user who lives and works across multiple zones.
 *
 * Invariant for the whole system: every stored *instant* is UTC ISO-8601.
 * Display/scheduling conversions happen only at the edges, using the user's
 * EFFECTIVE timezone — which is their GPS-derived *current* zone when we have a
 * fresh, trusted fix, otherwise their configured *home* zone.
 *
 * This module is deliberately pure (except `timezoneFromLocation`, which calls
 * geo-tz): callers fetch the current/home zone from their own settings store
 * and pass them in, so it has no DB dependency and is trivially testable.
 */
import { find } from 'geo-tz';

/** Zones the user works across; the agent expresses/schedules times in these. */
export const DEFAULT_WORKING_ZONES = [
  'America/Los_Angeles',
  'Europe/Berlin',
  'Asia/Jerusalem',
] as const;

/** Last-resort zone when neither a current nor a home zone is known. */
export const HOME_TIMEZONE_FALLBACK = 'Asia/Jerusalem';

/** How long a GPS-derived current zone stays trusted before we fall back to home. */
export const CURRENT_TZ_TTL_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Map a GPS coordinate to its IANA timezone (e.g. 32.08,34.78 → Asia/Jerusalem).
 * Returns null for invalid coordinates or if geo-tz can't resolve them.
 */
export function timezoneFromLocation(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try {
    const zones = find(lat, lon);
    return zones && zones.length ? zones[0] : null;
  } catch {
    return null;
  }
}

export interface EffectiveTzInput {
  /** GPS-derived current zone (IANA), if any. */
  currentTz?: string | null;
  /** ISO timestamp when `currentTz` was derived. */
  currentTzAt?: string | null;
  /** User's configured home zone (IANA). */
  homeTz?: string | null;
  /** Reference "now" (for testability). Defaults to real now. */
  now?: Date;
  /** Freshness window for `currentTz` (ms). Defaults to {@link CURRENT_TZ_TTL_MS}. */
  ttlMs?: number;
}

/**
 * The zone the user is effectively in right now: a fresh GPS-derived current
 * zone if available, else the configured home zone, else the global fallback.
 */
export function pickEffectiveTimezone(input: EffectiveTzInput): string {
  const { currentTz, currentTzAt, homeTz, now, ttlMs = CURRENT_TZ_TTL_MS } = input;
  const home = homeTz || HOME_TIMEZONE_FALLBACK;
  if (currentTz && currentTzAt) {
    const at = new Date(currentTzAt).getTime();
    const ref = (now ?? new Date()).getTime();
    if (Number.isFinite(at) && ref - at <= ttlMs) return currentTz;
  }
  return home;
}

/** True when the user appears to be away from home (fresh current zone ≠ home). */
export function isTraveling(input: EffectiveTzInput): boolean {
  return pickEffectiveTimezone(input) !== (input.homeTz || HOME_TIMEZONE_FALLBACK);
}
