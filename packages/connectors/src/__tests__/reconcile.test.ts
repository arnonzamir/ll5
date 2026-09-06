import { describe, it, expect } from 'vitest';
import { reconcile } from '../reconcile.js';

const M1 = 'mk-super-pharm';
const M2 = 'mk-wolt';

describe('reconcile (pure)', () => {
  it('matches same amount + same merchant_key within ±3 days, one-to-one', () => {
    const events = [
      { id: 'e1', amount: 214.9, merchant_key: M1, occurred_at: '2026-09-01T12:31:00Z' },
      { id: 'e2', amount: 58, merchant_key: M2, occurred_at: '2026-09-02T20:00:00Z' },
    ];
    const rows = [
      { id: 'r1', amount: 214.9, merchant_key: M1, occurred_at: '2026-09-03T00:00:00Z' },
      { id: 'r2', amount: 58, merchant_key: M2, occurred_at: '2026-09-04T00:00:00Z' },
      { id: 'r3', amount: 999, merchant_key: M2, occurred_at: '2026-09-04T00:00:00Z' },
    ];
    const r = reconcile(events, rows);
    expect(r.matches.map((m) => [m.event_id, m.row_id])).toEqual([['e1', 'r1'], ['e2', 'r2']]);
    expect(r.unmatched_events).toEqual([]);
    expect(r.unmatched_rows).toEqual(['r3']);
  });

  it('refuses a row outside the window, a different amount, or a different merchant', () => {
    const ev = { id: 'e1', amount: 100, merchant_key: M1, occurred_at: '2026-09-01T00:00:00Z' };
    const late = { id: 'r-late', amount: 100, merchant_key: M1, occurred_at: '2026-09-04T00:00:01Z' };
    const cents = { id: 'r-cents', amount: 100.01, merchant_key: M1, occurred_at: '2026-09-01T00:00:00Z' };
    const other = { id: 'r-other', amount: 100, merchant_key: M2, occurred_at: '2026-09-01T00:00:00Z' };
    const r = reconcile([ev], [late, cents, other]);
    expect(r.matches).toEqual([]);
    expect(r.unmatched_events).toEqual(['e1']);
    expect(r.unmatched_rows.sort()).toEqual(['r-cents', 'r-late', 'r-other']);
  });

  it('accepts a row exactly 3 days away and honours a custom window', () => {
    const ev = { id: 'e1', amount: 100, merchant_key: M1, occurred_at: '2026-09-01T00:00:00Z' };
    const edge = { id: 'r1', amount: 100, merchant_key: M1, occurred_at: '2026-09-04T00:00:00Z' };
    expect(reconcile([ev], [edge]).matches).toHaveLength(1);
    expect(reconcile([ev], [edge], { windowDays: 1 }).matches).toHaveLength(0);
  });

  it('never matches without a merchant_key or an amount on either side', () => {
    const r = reconcile(
      [
        { id: 'e-nokey', amount: 100, merchant_key: null, occurred_at: '2026-09-01T00:00:00Z' },
        { id: 'e-noamt', amount: null, merchant_key: M1, occurred_at: '2026-09-01T00:00:00Z' },
      ],
      [
        { id: 'r-nokey', amount: 100, merchant_key: null, occurred_at: '2026-09-01T00:00:00Z' },
        { id: 'r-ok', amount: 100, merchant_key: M1, occurred_at: '2026-09-01T00:00:00Z' },
      ],
    );
    expect(r.matches).toEqual([]);
  });

  it('is one-to-one: two identical events take two rows, the closest in time first', () => {
    const events = [
      { id: 'e-late', amount: 50, merchant_key: M1, occurred_at: '2026-09-02T00:00:00Z' },
      { id: 'e-early', amount: 50, merchant_key: M1, occurred_at: '2026-09-01T00:00:00Z' },
      { id: 'e-third', amount: 50, merchant_key: M1, occurred_at: '2026-09-01T06:00:00Z' },
    ];
    const rows = [
      { id: 'r-a', amount: 50, merchant_key: M1, occurred_at: '2026-09-01T01:00:00Z' },
      { id: 'r-b', amount: 50, merchant_key: M1, occurred_at: '2026-09-02T01:00:00Z' },
    ];
    const r = reconcile(events, rows);
    const byEvent = Object.fromEntries(r.matches.map((m) => [m.event_id, m.row_id]));
    expect(byEvent['e-early']).toBe('r-a');
    expect(byEvent['e-late']).toBe('r-b');
    expect(r.unmatched_events).toEqual(['e-third']);
    expect(new Set(r.matches.map((m) => m.row_id)).size).toBe(r.matches.length);
  });

  it('handles empty inputs', () => {
    expect(reconcile([], [])).toEqual({ matches: [], unmatched_events: [], unmatched_rows: [] });
  });
});
