/**
 * Reconciler — pure. Matches an event (near-real-time feed) to a ledger row
 * (batch feed): same amount, same merchant_key OR same masked account
 * reference (card last 4), occurred within ±windowDays, one-to-one. A merchant
 * match outranks an account-only match; ties go to the closest occurrence
 * time. Matching is USER-WIDE: card events arrive under the issuer's connector
 * id (max / isracard / cal / bank) while an aggregator's ledger rows sit under
 * its own id (financy), so neither side is filtered by connector here or in the
 * repository reads that feed it. Nothing here touches storage; the sync step
 * feeds it open events and candidate rows and persists the result.
 */

export interface ReconcileEvent {
  id: string;
  amount: number | null;
  merchant_key: string | null;
  /** Masked account reference (card last 4) when the source gave one. */
  account_ref?: string | null;
  occurred_at: string;
}

export interface ReconcileRow {
  id: string;
  amount: number | null;
  merchant_key: string | null;
  account_ref?: string | null;
  occurred_at: string;
}

export interface ReconcileMatch {
  event_id: string;
  row_id: string;
  /** Absolute distance between the two occurrence times, in hours. */
  delta_hours: number;
  /** What linked the pair besides the amount and the time window. */
  matched_on: 'merchant' | 'account';
}

export interface ReconcileResult {
  matches: ReconcileMatch[];
  unmatched_events: string[];
  unmatched_rows: string[];
}

export interface ReconcileOptions {
  /** Half-width of the time window. Default 3 days. */
  windowDays?: number;
  /** Amount tolerance in currency units. Default 0.005 (exact to the cent). */
  amountTolerance?: number;
}

const HOUR_MS = 3_600_000;

function sameAmount(a: number | null, b: number | null, tol: number): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tol;
}

function accountLast4(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null;
  const digits = ref.replace(/\D+/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function reconcile(
  events: ReconcileEvent[],
  rows: ReconcileRow[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const windowMs = (options.windowDays ?? 3) * 24 * HOUR_MS;
  const tol = options.amountTolerance ?? 0.005;

  // Every admissible (event, row) pair, best evidence and closest in time
  // first; then a greedy one-to-one pass — the best pairs win, so two identical
  // charges a day apart each take their own statement line.
  type Candidate = { ev: ReconcileEvent; row: ReconcileRow; delta: number; evTime: number; rank: 0 | 1; on: ReconcileMatch['matched_on'] };
  const candidates: Candidate[] = [];
  for (const ev of events) {
    const evTime = Date.parse(ev.occurred_at);
    const evAcct = accountLast4(ev.account_ref);
    if (ev.amount == null || !Number.isFinite(evTime)) continue;
    if (!ev.merchant_key && !evAcct) continue;
    for (const row of rows) {
      if (!sameAmount(ev.amount, row.amount, tol)) continue;
      const byMerchant = Boolean(ev.merchant_key && row.merchant_key && row.merchant_key === ev.merchant_key);
      const rowAcct = accountLast4(row.account_ref);
      const byAccount = Boolean(evAcct && rowAcct && evAcct === rowAcct);
      if (!byMerchant && !byAccount) continue;
      const rowTime = Date.parse(row.occurred_at);
      if (!Number.isFinite(rowTime)) continue;
      const delta = Math.abs(rowTime - evTime);
      if (delta > windowMs) continue;
      candidates.push({ ev, row, delta, evTime, rank: byMerchant ? 0 : 1, on: byMerchant ? 'merchant' : 'account' });
    }
  }
  candidates.sort(
    (a, b) => a.rank - b.rank || a.delta - b.delta || a.evTime - b.evTime || a.ev.id.localeCompare(b.ev.id) || a.row.id.localeCompare(b.row.id),
  );

  const usedEvents = new Set<string>();
  const usedRows = new Set<string>();
  const chosen: Candidate[] = [];
  for (const c of candidates) {
    if (usedEvents.has(c.ev.id) || usedRows.has(c.row.id)) continue;
    usedEvents.add(c.ev.id);
    usedRows.add(c.row.id);
    chosen.push(c);
  }
  // Report in event-time order (stable for callers), not in match-quality order.
  const matches: ReconcileMatch[] = chosen
    .sort((a, b) => a.evTime - b.evTime || a.ev.id.localeCompare(b.ev.id))
    .map((c) => ({ event_id: c.ev.id, row_id: c.row.id, delta_hours: c.delta / HOUR_MS, matched_on: c.on }));

  const unmatched_events = events.filter((e) => !usedEvents.has(e.id)).map((e) => e.id);
  const unmatched_rows = rows.filter((r) => !usedRows.has(r.id)).map((r) => r.id);
  return { matches, unmatched_events, unmatched_rows };
}
