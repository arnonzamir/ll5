import { describe, it, expect } from 'vitest';
import { aggregateDeliveryStats, bucketKey, deadlineBand } from '../utils/delivery-stats.js';
import type { StatsRow } from '../utils/delivery-stats.js';

// DECISION-034 Phase 4 — bucket key + aggregate math, pure.

const SENT = '2026-09-07T08:00:00Z';

describe('deadlineBand', () => {
  it('near < 2 h, day < 24 h, far otherwise (or no deadline)', () => {
    expect(deadlineBand('2026-09-07T09:59:00Z', SENT)).toBe('near');
    expect(deadlineBand('2026-09-07T10:00:00Z', SENT)).toBe('day');
    expect(deadlineBand('2026-09-08T07:59:00Z', SENT)).toBe('day');
    expect(deadlineBand('2026-09-08T08:00:00Z', SENT)).toBe('far');
    expect(deadlineBand(null, SENT)).toBe('far');
  });
  it('bucketKey is class|stakes|band|mode with defaults', () => {
    expect(bucketKey('do-by', 'high', 'near', 'driving')).toBe('do-by|high|near|driving');
    expect(bucketKey('needs-you', null, 'far', null)).toBe('needs-you|none|far|normal');
  });
});

function row(o: Partial<StatsRow>): StatsRow {
  return {
    class: 'needs-you', stakes: 'medium', due_at: '2026-09-07T09:00:00Z', created_at: SENT, delivery_mode: 'normal',
    modality: 'push_notify', status: 'sent', seen_at: null, acknowledged_at: null, done_at: null,
    dismissed_at: null, feedback: null, explored: false, policy_bucket: null, ...o,
  };
}

describe('aggregateDeliveryStats', () => {
  it('counts per bucket x modality: sent / seen / acknowledged / done_by_deadline / dismissed / missed / feedback / explored', () => {
    const buckets = aggregateDeliveryStats([
      row({ seen_at: '2026-09-07T08:10:00Z', acknowledged_at: '2026-09-07T08:11:00Z' }),
      row({ seen_at: '2026-09-07T08:10:00Z', done_at: '2026-09-07T08:30:00Z', status: 'done', acknowledged_at: '2026-09-07T08:30:00Z' }),
      row({ done_at: '2026-09-07T09:30:00Z', status: 'done' }),                           // done, but after due
      row({ dismissed_at: '2026-09-07T08:05:00Z', status: 'expired' }),                    // dismissed without action, then missed
      row({ dismissed_at: '2026-09-07T08:05:00Z', acknowledged_at: '2026-09-07T08:06:00Z' }), // dismissed then acknowledged → not "dismissed"
      row({ modality: 'push_alert', explored: true, feedback: 'too_much', seen_at: '2026-09-07T08:01:00Z' }),
      row({ modality: 'push_alert', feedback: 'not_enough' }),
      row({ class: 'do-by', stakes: 'high', due_at: '2026-09-07T20:00:00Z', delivery_mode: 'meeting', modality: 'push_alert', status: 'missed' }),
    ]);
    expect(buckets.map((b) => b.key)).toEqual(['do-by|high|day|meeting', 'needs-you|medium|near|normal']);

    const ny = buckets[1];
    expect(ny.n).toBe(7);
    expect(Object.keys(ny.modalities)).toEqual(['push_alert', 'push_notify']);
    expect(ny.modalities.push_notify).toEqual({
      sent: 5, seen: 2, acknowledged: 3, done_by_deadline: 1, dismissed: 1, missed: 1, too_much: 0, not_enough: 0, explored: 0,
    });
    expect(ny.modalities.push_alert).toEqual({
      sent: 2, seen: 1, acknowledged: 0, done_by_deadline: 0, dismissed: 0, missed: 0, too_much: 1, not_enough: 1, explored: 1,
    });

    const db = buckets[0];
    expect(db.n).toBe(1);
    expect(db.modalities.push_alert.missed).toBe(1);
  });

  it('a stored policy_bucket wins over the recomputed key', () => {
    const buckets = aggregateDeliveryStats([row({ policy_bucket: 'needs-you|medium|near|driving' })]);
    expect(buckets[0].key).toBe('needs-you|medium|near|driving');
  });

  it('done with no deadline counts as done by deadline', () => {
    const buckets = aggregateDeliveryStats([row({ class: 'fyi', due_at: null, done_at: '2026-09-07T09:00:00Z', modality: 'chat' })]);
    expect(buckets[0].key).toBe('fyi|medium|far|normal');
    expect(buckets[0].modalities.chat.done_by_deadline).toBe(1);
  });

  it('empty in, empty out', () => {
    expect(aggregateDeliveryStats([])).toEqual([]);
  });
});
