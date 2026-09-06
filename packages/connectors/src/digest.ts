/**
 * Pure pieces of get_connector_digest: the period → [since, until) range in the
 * user's zone, and the per-connector aggregation over decrypted rows.
 */
import type { ConnectorEventRecord } from '@ll5/shared';
import type { LedgerRowRecord } from './types.js';

export type DigestPeriod = 'today' | 'yesterday' | 'week';

const DAY_MS = 24 * 3_600_000;

function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // ICU may print midnight as 24 — read hours modulo 24.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - date.getTime();
}

/** Start of the local day containing `date`, as a UTC instant. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const off = tzOffsetMs(date, timeZone);
  const local = new Date(date.getTime() + off);
  const midnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let result = new Date(midnightAsUtc - off);
  const off2 = tzOffsetMs(result, timeZone);
  if (off2 !== off) result = new Date(midnightAsUtc - off2);
  return result;
}

export function periodRange(period: DigestPeriod, now: Date, timeZone: string): { since: string; until: string } {
  const today = startOfLocalDay(now, timeZone);
  switch (period) {
    case 'today':
      return { since: today.toISOString(), until: now.toISOString() };
    case 'yesterday':
      return { since: new Date(today.getTime() - DAY_MS).toISOString(), until: today.toISOString() };
    case 'week':
      return { since: new Date(today.getTime() - 6 * DAY_MS).toISOString(), until: now.toISOString() };
  }
}

export interface MerchantStat {
  merchant: string;
  count: number;
  total: number;
}

export interface ConnectorDigest {
  id: string;
  label: string;
  enabled: boolean;
  status: string;
  events: {
    count: number;
    totals: Record<string, number>;
    top_merchants: MerchantStat[];
    rule_hits: Record<string, number>;
    unmatched: number;
  };
  ledger: {
    count: number;
    totals: Record<string, number>;
  };
  open_findings_count: number;
  open_findings: Array<{ id: string; kind: string; summary: string; opened_at: string }>;
  feed_ages: { events_minutes: number | null; ledger_minutes: number | null };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addTotal(totals: Record<string, number>, currency: string | null, amount: number | null): void {
  if (amount == null) return;
  const c = currency ?? '???';
  totals[c] = round2((totals[c] ?? 0) + amount);
}

/** Signed amount for money kinds: refunds subtract. */
function signed(kind: string, amount: number | null): number | null {
  if (amount == null) return null;
  return kind === 'refund' ? -amount : amount;
}

export function summarizeEvents(events: ConnectorEventRecord[]): ConnectorDigest['events'] {
  const totals: Record<string, number> = {};
  const rule_hits: Record<string, number> = {};
  const merchants = new Map<string, MerchantStat>();
  let unmatched = 0;
  for (const ev of events) {
    addTotal(totals, ev.currency ?? null, signed(ev.kind, ev.amount ?? null));
    for (const r of ev.rule_hits ?? []) rule_hits[r] = (rule_hits[r] ?? 0) + 1;
    if (ev.status === 'open' || ev.status === 'expired') unmatched++;
    if (ev.merchant) {
      const m = merchants.get(ev.merchant) ?? { merchant: ev.merchant, count: 0, total: 0 };
      m.count++;
      m.total = round2(m.total + (signed(ev.kind, ev.amount ?? null) ?? 0));
      merchants.set(ev.merchant, m);
    }
  }
  const top_merchants = [...merchants.values()].sort((a, b) => b.total - a.total || b.count - a.count).slice(0, 5);
  return { count: events.length, totals, top_merchants, rule_hits, unmatched };
}

export function summarizeLedger(rows: LedgerRowRecord[]): ConnectorDigest['ledger'] {
  const totals: Record<string, number> = {};
  for (const r of rows) addTotal(totals, r.currency, signed(r.kind, r.amount));
  return { count: rows.length, totals };
}

export function ageMinutes(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}
