import type { Pool } from 'pg';
import { pickEffectiveTimezone, HOME_TIMEZONE_FALLBACK } from '@ll5/shared';
import { logger } from './logger.js';

/**
 * Resolve the user's EFFECTIVE timezone right now: a fresh GPS-derived current
 * zone (cached in user_settings.current_timezone / current_timezone_at by the
 * location processor) if recent, else the configured home zone (settings.timezone),
 * else the global fallback.
 *
 * Reads user_settings per call — the schedulers tick on the minute/5-minute
 * scale, so a small per-tick query is acceptable and keeps the effective zone
 * fresh as the user travels (vs. the old static startup-resolved timezone).
 */
export async function getEffectiveTimezone(pool: Pool, userId: string): Promise<string> {
  try {
    const result = await pool.query<{
      current_tz: string | null;
      current_tz_at: string | null;
      home_tz: string | null;
    }>(
      `SELECT settings->>'current_timezone' AS current_tz,
              settings->>'current_timezone_at' AS current_tz_at,
              settings->>'timezone' AS home_tz
       FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return pickEffectiveTimezone({
      currentTz: row?.current_tz ?? null,
      currentTzAt: row?.current_tz_at ?? null,
      homeTz: row?.home_tz ?? null,
    });
  } catch (err) {
    // Never let a settings-read hiccup break a tick — fall back to home default.
    logger.warn('[timezone][getEffectiveTimezone] settings read failed — using fallback', {
      userId,
      fallback: HOME_TIMEZONE_FALLBACK,
      error: err instanceof Error ? err.message : String(err),
    });
    return HOME_TIMEZONE_FALLBACK;
  }
}

/** Local calendar Y/M/D of an instant, as seen in a given IANA timezone. */
function localYMDInTz(date: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The UTC offset (ms) of a timezone at a given instant. */
function tzOffsetMs(date: Date, tz: string): number {
  // Format the instant as wall-clock time in the zone, parse it back as if UTC,
  // and the difference from the real instant is the zone's offset.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  let hour = get('hour');
  if (hour === 24) hour = 0; // some engines render midnight as 24
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - date.getTime();
}

/**
 * The UTC instant for local midnight (00:00) of `date`'s calendar day in `tz`.
 * Replaces the server-process `new Date(y, m, d)` which silently uses the host's
 * timezone — wrong when the host tz differs from the user's.
 */
export function startOfDayInTz(date: Date, tz: string): Date {
  const { year, month, day } = localYMDInTz(date, tz);
  // Build the UTC guess for local midnight, then correct by the zone's offset at
  // that instant (a single correction is exact away from a DST boundary, which
  // day-start windows never straddle in practice).
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = tzOffsetMs(new Date(utcGuess), tz);
  return new Date(utcGuess - offset);
}

/**
 * The UTC instant for the END of `date`'s calendar day in `tz` (i.e. the start
 * of the NEXT local day — exclusive upper bound, mirroring the existing
 * `startOfDay + 24h` windows).
 */
export function endOfDayInTz(date: Date, tz: string): Date {
  return new Date(startOfDayInTz(date, tz).getTime() + 24 * 60 * 60 * 1000);
}
