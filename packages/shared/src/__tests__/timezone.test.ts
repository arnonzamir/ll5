import { describe, it, expect } from 'vitest';
import {
  timezoneFromLocation,
  pickEffectiveTimezone,
  isTraveling,
  HOME_TIMEZONE_FALLBACK,
  CURRENT_TZ_TTL_MS,
} from '../utils/timezone.js';

describe('timezoneFromLocation', () => {
  it('maps known coordinates to their IANA zone', () => {
    expect(timezoneFromLocation(37.7749, -122.4194)).toBe('America/Los_Angeles'); // SF
    expect(timezoneFromLocation(52.52, 13.405)).toBe('Europe/Berlin');            // Berlin
    expect(timezoneFromLocation(32.0853, 34.7818)).toBe('Asia/Jerusalem');         // Tel Aviv
  });
  it('returns null for invalid coordinates', () => {
    expect(timezoneFromLocation(NaN, 0)).toBeNull();
    expect(timezoneFromLocation(Infinity, Infinity)).toBeNull();
  });
});

describe('pickEffectiveTimezone', () => {
  const now = new Date('2026-06-19T12:00:00Z');

  it('uses a fresh GPS-derived current zone over home', () => {
    expect(pickEffectiveTimezone({
      currentTz: 'America/Los_Angeles',
      currentTzAt: new Date(now.getTime() - 60_000).toISOString(),
      homeTz: 'Asia/Jerusalem',
      now,
    })).toBe('America/Los_Angeles');
  });

  it('falls back to home when the current zone is stale', () => {
    expect(pickEffectiveTimezone({
      currentTz: 'America/Los_Angeles',
      currentTzAt: new Date(now.getTime() - (CURRENT_TZ_TTL_MS + 1)).toISOString(),
      homeTz: 'Asia/Jerusalem',
      now,
    })).toBe('Asia/Jerusalem');
  });

  it('falls back to home when no current zone is known', () => {
    expect(pickEffectiveTimezone({ homeTz: 'Europe/Berlin', now })).toBe('Europe/Berlin');
  });

  it('falls back to the global default when nothing is known', () => {
    expect(pickEffectiveTimezone({ now })).toBe(HOME_TIMEZONE_FALLBACK);
  });
});

describe('isTraveling', () => {
  const now = new Date('2026-06-19T12:00:00Z');
  it('is true when a fresh current zone differs from home', () => {
    expect(isTraveling({
      currentTz: 'America/Los_Angeles',
      currentTzAt: now.toISOString(),
      homeTz: 'Asia/Jerusalem',
      now,
    })).toBe(true);
  });
  it('is false at home (stale or matching current zone)', () => {
    expect(isTraveling({ homeTz: 'Asia/Jerusalem', now })).toBe(false);
    expect(isTraveling({
      currentTz: 'Asia/Jerusalem',
      currentTzAt: now.toISOString(),
      homeTz: 'Asia/Jerusalem',
      now,
    })).toBe(false);
  });
});
