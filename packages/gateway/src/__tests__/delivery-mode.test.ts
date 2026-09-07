import { describe, it, expect } from "vitest";
import { inQuietHours, nextQuietEnd, looksSick, pickMode, isUserMeeting } from '../utils/delivery-mode.js';
import { buildDigest, unseenDigestRows } from '../scheduler/quiet-hours-release.js';

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

describe('buildDigest (DECISION-034: no trim, class lines, asks first)', () => {
  const at = (utc: string) => new Date(utc);
  it('one line per held push, local time, class shown, long first lines kept whole', () => {
    const rows = [
      { content: 'Wine tasting is in 2.5 hours. Still off unless you say otherwise, and this sentence runs well past the old one-hundred-and-sixty character trim so the whole line must survive intact.', created_at: at('2026-09-05T23:07:00Z') },
      { content: 'Shokz connected at 05:08.\nIf that means a swim…', created_at: at('2026-09-06T02:10:00Z'), class: 'fyi' as const },
    ];
    const d = buildDigest(rows, TZ);
    expect(d.split('\n')[0]).toBe('Held overnight (2):');
    expect(d).toContain('- 02:07 · fyi · Wine tasting is in 2.5 hours. Still off unless you say otherwise, and this sentence runs well past the old one-hundred-and-sixty character trim so the whole line must survive intact.');
    expect(d).not.toContain('…');
    // Only the FIRST line of a multi-line item is used — but it is not trimmed.
    expect(d).toContain('- 05:10 · fyi · Shokz connected at 05:08.');
    expect(d).not.toContain('If that means');
  });

  it('open asks lead (do-by, then needs-you, then fyi by time) and carry class · subject — first line', () => {
    const rows = [
      { content: 'Shokz connected at 05:08.', created_at: at('2026-09-06T02:10:00Z'), class: 'fyi' as const },
      { content: 'Dentist form: sign and send back before 09:00.', created_at: at('2026-09-06T01:00:00Z'), class: 'needs-you' as const, subject: 'Dentist form' },
      { content: 'Card pickup, 17 HaNadiv — the branch closes at 13:00.', created_at: at('2026-09-06T03:00:00Z'), class: 'do-by' as const, subject: 'Card pickup, 17 HaNadiv' },
    ];
    const lines = buildDigest(rows, TZ).split('\n');
    expect(lines[0]).toBe('Held overnight (3):');
    expect(lines[1]).toBe('- 06:00 · do-by · Card pickup, 17 HaNadiv — Card pickup, 17 HaNadiv — the branch closes at 13:00.');
    expect(lines[2]).toBe('- 04:00 · needs-you · Dentist form — Dentist form: sign and send back before 09:00.');
    expect(lines[3]).toBe('- 05:10 · fyi · Shokz connected at 05:08.');
  });

  it('Phase 3: items the user already saw (seen_at) are dropped from the digest; the count follows', () => {
    const rows = [
      { content: 'Card pickup, 17 HaNadiv — closes at 13:00.', created_at: at('2026-09-06T03:00:00Z'), class: 'do-by' as const, subject: 'Card pickup, 17 HaNadiv', seen_at: at('2026-09-06T03:20:00Z') },
      { content: 'Dentist form: sign and send back.', created_at: at('2026-09-06T01:00:00Z'), class: 'needs-you' as const, subject: 'Dentist form', seen_at: null },
      { content: 'Shokz connected at 05:08.', created_at: at('2026-09-06T02:10:00Z'), class: 'fyi' as const },
    ];
    const unseen = unseenDigestRows(rows);
    expect(unseen.map((r) => r.class)).toEqual(['needs-you', 'fyi']);
    const d = buildDigest(unseen, TZ);
    expect(d.split('\n')[0]).toBe('Held overnight (2):');
    expect(d).not.toContain('Card pickup');
    expect(unseenDigestRows([rows[0]])).toEqual([]);
  });
});

describe('isUserMeeting (2026-09-07: meeting false positives)', () => {
  const base = { status: 'confirmed', calendar_name: 'arnon@example.com', start_time: '2026-09-07T18:00:00+03:00', end_time: '2026-09-07T19:00:00+03:00', availability: 'busy' };
  it('a normal 1 h work meeting counts', () => { expect(isUserMeeting({ ...base, title: 'Sync with Gill' })).toBe(true); });
  it('placeholders, agent notes, free blocks, cancelled do not', () => {
    expect(isUserMeeting({ ...base, title: 'SAVE THE DATE - Rosh Hashanah Event' })).toBe(false);
    expect(isUserMeeting({ ...base, title: '[agent] review' })).toBe(false);
    expect(isUserMeeting({ ...base, title: 'Sync', availability: 'free' })).toBe(false);
    expect(isUserMeeting({ ...base, title: 'Sync', status: 'cancelled' })).toBe(false);
  });
  it('long blocks and shared named calendars do not', () => {
    expect(isUserMeeting({ ...base, title: 'Offsite', end_time: '2026-09-07T22:30:00+03:00' })).toBe(false);
    expect(isUserMeeting({ ...base, title: 'ערב אימהות א1', calendar_name: 'Family' })).toBe(false);
    expect(isUserMeeting({ ...base, title: 'Sync', calendar_name: 'primary' })).toBe(true);
    expect(isUserMeeting({ ...base, title: 'Sync', calendar_name: 'Work', attendees: "['a@x.com (organizer)', 'arnon@example.com']" })).toBe(true);
    expect(isUserMeeting({ ...base, title: 'Birthday dinner' })).toBe(true);
  });
});
