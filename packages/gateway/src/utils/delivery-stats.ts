import type { DeliveryClass, Modality, Stakes } from './delivery-contract.js';

/**
 * Delivery stats — pure aggregation (DECISION-034 Phase 4).
 *
 * `GET /me/delivery-stats?days=14` buckets every classed delivery by the
 * context it was sent in and, per modality, counts what happened to it. The
 * agent's nightly pass reads this and writes the `delivery_policy` user
 * model section; the gateway reads that policy back at send time
 * (`delivery-policy.ts`).
 *
 * Bucket key: `<class>|<stakes>|<deadline_band>|<mode_at_send>` where
 * deadline_band is `near` (< 2 h to due), `day` (< 24 h) or `far` (later, or
 * no deadline).
 */

export type DeadlineBand = 'near' | 'day' | 'far';
export const DEADLINE_BANDS: readonly DeadlineBand[] = ['near', 'day', 'far'];

const HOUR = 3_600_000;

export function deadlineBand(dueAt: string | Date | null | undefined, sentAt: string | Date): DeadlineBand {
  if (!dueAt) return 'far';
  const left = new Date(dueAt).getTime() - new Date(sentAt).getTime();
  if (left < 2 * HOUR) return 'near';
  if (left < 24 * HOUR) return 'day';
  return 'far';
}

export function bucketKey(cls: DeliveryClass, stakes: Stakes | null | undefined, band: DeadlineBand, mode: string | null | undefined): string {
  return `${cls}|${stakes ?? 'none'}|${band}|${mode ?? 'normal'}`;
}

export interface StatsRow {
  class: DeliveryClass;
  stakes: Stakes | null;
  due_at: string | Date | null;
  created_at: string | Date;
  delivery_mode: string | null;
  modality: Modality;
  status: string;
  seen_at: string | Date | null;
  acknowledged_at: string | Date | null;
  done_at: string | Date | null;
  dismissed_at?: string | Date | null;
  feedback?: string | null;
  explored?: boolean | null;
  /** When the row was bucketed at send time the stored key wins (the mode then is the mode that mattered). */
  policy_bucket?: string | null;
}

export interface ModalityStats {
  sent: number;
  seen: number;
  acknowledged: number;
  done_by_deadline: number;
  dismissed: number;
  missed: number;
  too_much: number;
  not_enough: number;
  /** Sends that were exploration picks — the policy's own hit rate is (sent - explored). */
  explored: number;
}

export interface StatsBucket {
  key: string;
  n: number;
  modalities: Record<string, ModalityStats>;
}

const emptyStats = (): ModalityStats => ({
  sent: 0, seen: 0, acknowledged: 0, done_by_deadline: 0, dismissed: 0, missed: 0, too_much: 0, not_enough: 0, explored: 0,
});

/** Pure: bucket × modality counts. Buckets and modalities come out in a stable (sorted) order. */
export function aggregateDeliveryStats(rows: StatsRow[]): StatsBucket[] {
  const buckets = new Map<string, StatsBucket>();
  for (const r of rows) {
    const key = r.policy_bucket ?? bucketKey(r.class, r.stakes, deadlineBand(r.due_at, r.created_at), r.delivery_mode);
    let b = buckets.get(key);
    if (!b) { b = { key, n: 0, modalities: {} }; buckets.set(key, b); }
    b.n += 1;
    const m = (b.modalities[r.modality] ??= emptyStats());
    m.sent += 1;
    if (r.seen_at) m.seen += 1;
    if (r.acknowledged_at) m.acknowledged += 1;
    if (r.done_at && (!r.due_at || new Date(r.done_at).getTime() <= new Date(r.due_at).getTime())) m.done_by_deadline += 1;
    if (r.dismissed_at && !r.acknowledged_at && !r.done_at) m.dismissed += 1;
    if (r.status === 'missed' || r.status === 'expired') m.missed += 1;
    if (r.feedback === 'too_much') m.too_much += 1;
    if (r.feedback === 'not_enough') m.not_enough += 1;
    if (r.explored) m.explored += 1;
  }
  return [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => ({ ...b, modalities: Object.fromEntries(Object.entries(b.modalities).sort(([a], [c]) => a.localeCompare(c))) }));
}
