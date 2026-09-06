import { describe, it, expect } from 'vitest';
import { periodRange, startOfLocalDay, summarizeEvents, summarizeLedger, ageMinutes } from '../digest.js';
import type { ConnectorEventRecord } from '@ll5/shared';

const TZ = 'Asia/Jerusalem';

describe('periodRange (local day in the user\'s zone)', () => {
  // 2026-09-06 01:30 IDT (UTC+3) == 2026-09-05 22:30Z — the local day is already the 6th.
  const now = new Date('2026-09-05T22:30:00Z');

  it('startOfLocalDay is local midnight, not UTC midnight', () => {
    expect(startOfLocalDay(now, TZ).toISOString()).toBe('2026-09-05T21:00:00.000Z');
    expect(startOfLocalDay(now, 'UTC').toISOString()).toBe('2026-09-05T00:00:00.000Z');
  });

  it('today / yesterday / week', () => {
    expect(periodRange('today', now, TZ)).toEqual({ since: '2026-09-05T21:00:00.000Z', until: now.toISOString() });
    expect(periodRange('yesterday', now, TZ)).toEqual({ since: '2026-09-04T21:00:00.000Z', until: '2026-09-05T21:00:00.000Z' });
    expect(periodRange('week', now, TZ)).toEqual({ since: '2026-08-30T21:00:00.000Z', until: now.toISOString() });
  });
});

function ev(p: Partial<ConnectorEventRecord>): ConnectorEventRecord {
  return {
    id: 'x', connector_id: 'cal', kind: 'charge', occurred_at: '2026-09-06T10:00:00Z', received_at: '2026-09-06T10:00:00Z',
    amount: 10, currency: 'ILS', merchant: 'Wolt', dedupe_key: 'k', status: 'open', matched_row_id: null, payload: null, rule_hits: [],
    ...p,
  };
}

describe('summarizeEvents', () => {
  it('totals by currency with refunds subtracting, top 5 merchants by total, rule hits, unmatched', () => {
    const events = [
      ev({ id: '1', amount: 214.9, merchant: 'Super-Pharm', rule_hits: ['amount_threshold'] }),
      ev({ id: '2', amount: 58, merchant: 'Wolt', status: 'matched' }),
      ev({ id: '3', amount: 20, merchant: 'Wolt', kind: 'refund', status: 'expired' }),
      ev({ id: '4', amount: 12, currency: 'USD', merchant: 'Amazon', foreign: true, rule_hits: ['foreign', 'unknown_merchant'] }),
      ...['a', 'b', 'c', 'd'].map((m, i) => ev({ id: m, amount: i + 1, merchant: m })),
    ];
    const s = summarizeEvents(events);
    expect(s.count).toBe(8);
    expect(s.totals).toEqual({ ILS: 262.9, USD: 12 });
    expect(s.top_merchants).toHaveLength(5);
    expect(s.top_merchants[0]).toEqual({ merchant: 'Super-Pharm', count: 1, total: 214.9 });
    expect(s.top_merchants[1]).toEqual({ merchant: 'Wolt', count: 2, total: 38 });
    expect(s.rule_hits).toEqual({ amount_threshold: 1, foreign: 1, unknown_merchant: 1 });
    expect(s.unmatched).toBe(7);
  });

  it('summarizeLedger totals and ageMinutes', () => {
    const rows = [
      { id: 'r1', connector_id: 'cal', account_ref: null, external_id: 'a', kind: 'charge', occurred_at: '', posted_at: null, amount: 100, currency: 'ILS', merchant_key: null, payload: null, fetched_at: '' },
      { id: 'r2', connector_id: 'cal', account_ref: null, external_id: 'b', kind: 'refund', occurred_at: '', posted_at: null, amount: 30, currency: 'ILS', merchant_key: null, payload: null, fetched_at: '' },
    ];
    expect(summarizeLedger(rows)).toEqual({ count: 2, totals: { ILS: 70 } });
    const now = new Date('2026-09-06T12:00:00Z');
    expect(ageMinutes('2026-09-06T11:15:00Z', now)).toBe(45);
    expect(ageMinutes(null, now)).toBeNull();
    expect(ageMinutes('garbage', now)).toBeNull();
  });
});
