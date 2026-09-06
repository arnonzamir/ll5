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

  it('is connector-agnostic: nothing about the pair depends on where either side came from', () => {
    // A card event (issuer connector) and an aggregator ledger row carry no connector id at all here.
    const ev = { id: 'e-max', amount: 214.9, merchant_key: M1, occurred_at: '2026-09-01T12:31:00Z' };
    const row = { id: 'r-financy', amount: 214.9, merchant_key: M1, occurred_at: '2026-09-03T00:00:00Z' };
    expect(reconcile([ev], [row]).matches).toEqual([{ event_id: 'e-max', row_id: 'r-financy', delta_hours: 35.483333333333334, matched_on: 'merchant' }]);
  });

  it('falls back to the masked account last 4 when the merchant strings differ (app push vs statement wording)', () => {
    const ev = { id: 'e1', amount: 73.42, merchant_key: 'mk-amazon-marketplace', account_ref: '4321', occurred_at: '2026-09-05T09:00:00Z' };
    const rows = [
      { id: 'r-other-card', amount: 73.42, merchant_key: 'mk-amzn-mktp-us', account_ref: '**** 9999', occurred_at: '2026-09-06T00:00:00Z' },
      { id: 'r-same-card', amount: 73.42, merchant_key: 'mk-amzn-mktp-us', account_ref: '**** **** **** 4321', occurred_at: '2026-09-06T00:00:00Z' },
    ];
    const r = reconcile([ev], rows);
    expect(r.matches).toEqual([{ event_id: 'e1', row_id: 'r-same-card', delta_hours: 15, matched_on: 'account' }]);
    expect(r.unmatched_rows).toEqual(['r-other-card']);
  });

  it('a merchant match outranks a closer account-only match', () => {
    const ev = { id: 'e1', amount: 100, merchant_key: M1, account_ref: '1234', occurred_at: '2026-09-01T00:00:00Z' };
    const rows = [
      { id: 'r-account-close', amount: 100, merchant_key: M2, account_ref: '1234', occurred_at: '2026-09-01T01:00:00Z' },
      { id: 'r-merchant-far', amount: 100, merchant_key: M1, account_ref: '9999', occurred_at: '2026-09-03T00:00:00Z' },
    ];
    expect(reconcile([ev], rows).matches[0]).toMatchObject({ row_id: 'r-merchant-far', matched_on: 'merchant' });
  });

  it('an account-only match still needs the same amount and the window', () => {
    const ev = { id: 'e1', amount: 100, merchant_key: null, account_ref: '1234', occurred_at: '2026-09-01T00:00:00Z' };
    const rows = [
      { id: 'r-amount', amount: 101, merchant_key: null, account_ref: '1234', occurred_at: '2026-09-01T00:00:00Z' },
      { id: 'r-late', amount: 100, merchant_key: null, account_ref: '1234', occurred_at: '2026-09-04T00:00:01Z' },
    ];
    expect(reconcile([ev], rows).matches).toEqual([]);
  });
});
