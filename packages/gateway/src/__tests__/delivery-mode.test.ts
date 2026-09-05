import { describe, it, expect } from 'vitest';
import { inQuietHours, nextQuietEnd, looksSick, pickMode } from '../utils/delivery-mode.js';
import { buildDigest } from '../scheduler/quiet-hours-release.js';

const TZ = 'Asia/Jerusalem'; // UTC+3 in September
const at = (utc: string) => new Date(utc);

describe('quiet hours (DECISION-030)', () => {
  it('23:30–06:30 local wraps midnight correctly', () => {
    expect(inQuietHours(at('2026-09-05T20:45:00Z'), TZ)).toBe(true);  // 23:45 local
    expect(inQuietHours(at('2026-09-05T23:00:00Z'), TZ)).toBe(true);  // 02:00 local
    expect(inQuietHours(at('2026-09-06T03:29:00Z'), TZ)).toBe(true);  // 06:29 local
    expect(inQuietHours(at('2026-09-06T03:30:00Z'), TZ)).toBe(false); // 06:30 local
    expect(inQuietHours(at('2026-09-05T20:29:00Z'), TZ)).toBe(false); // 23:29 local
    expect(inQuietHours(at('2026-09-05T12:00:00Z'), TZ)).toBe(false);
  });

  it('a non-wrapping window works too', () => {
    expect(inQuietHours(at('2026-09-05T10:00:00Z'), TZ, { start: '12:00', end: '14:00' })).toBe(true); // 13:00 local
    expect(inQuietHours(at('2026-09-05T12:00:00Z'), TZ, { start: '12:00', end: '14:00' })).toBe(false); // 15:00 local
  });

  it('nextQuietEnd is the coming 06:30 local, as an instant', () => {
    expect(nextQuietEnd(at('2026-09-05T23:00:00Z'), TZ)).toBe('2026-09-06T03:30:00.000Z'); // 02:00 → 06:30 same night
    expect(nextQuietEnd(at('2026-09-05T20:45:00Z'), TZ)).toBe('2026-09-06T03:30:00.000Z'); // 23:45 → next morning
  });
});

describe('pickMode precedence + sick detection', () => {
  it('sleep beats quiet hours beats driving beats meeting beats sick', () => {
    expect(pickMode({ quiet: true, asleep: true, driving: true, meeting: true, sick: true }).mode).toBe('sleep');
    expect(pickMode({ quiet: true, asleep: false, driving: true, meeting: true, sick: true }).mode).toBe('quiet_hours');
    expect(pickMode({ quiet: false, asleep: false, driving: true, meeting: true, sick: true }).mode).toBe('driving');
    expect(pickMode({ quiet: false, asleep: false, driving: false, meeting: true, sick: true }).mode).toBe('meeting');
    expect(pickMode({ quiet: false, asleep: false, driving: false, meeting: false, sick: true }).mode).toBe('sick');
    expect(pickMode({ quiet: false, asleep: false, driving: false, meeting: false, sick: false })).toEqual({ mode: 'normal', reasons: [] });
  });

  it('looksSick reads the agent\'s active_context in English and Hebrew, and ignores unrelated text', () => {
    expect(looksSick({ hot_topics: ['ARNON SICK — fever 38.2°C last night'] })).toBe(true);
    expect(looksSick({ current_mood: 'קצת חולה, חום' })).toBe(true);
    expect(looksSick({ hot_topics: ['Wine tasting at Rami\'s', 'kids first school day'] })).toBe(false);
    expect(looksSick(null)).toBe(false);
  });
});

describe('buildDigest', () => {
  it('one line per held push, local time, long items trimmed to their first line', () => {
    const rows = [
      { id: '1', content: 'Wine tasting is in 2.5 hours. Still off unless you say otherwise.', notification_level: 'notify', reason: 'quiet_hours', created_at: new Date('2026-09-05T23:07:00Z') },
      { id: '2', content: 'Shokz connected at 05:08.\nIf that means a swim…', notification_level: null, reason: 'sleep', created_at: new Date('2026-09-06T02:10:00Z') },
    ];
    const d = buildDigest(rows, TZ);
    expect(d.split('\n')[0]).toBe('Held overnight (2):');
    expect(d).toContain('- 02:07 Wine tasting is in 2.5 hours.');
    expect(d).toContain('- 05:10 Shokz connected at 05:08.');
    expect(d).not.toContain('If that means');
  });
});
