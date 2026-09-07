import { describe, it, expect } from 'vitest';
import {
  countsAsUnseen, deriveSeenAt, foldReadState, normalizeEvents, reduceDeliveryEvents, seenAgeText, unseenCount,
} from '../utils/delivery-seen.js';

// DECISION-034 Phase 3 — the seen model, pure.

const NOW = new Date('2026-09-07T10:00:00Z');
const M1 = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';

describe('normalizeEvents', () => {
  it('keeps valid events, clamps future timestamps to now, drops junk and counts it', () => {
    const { events, rejected } = normalizeEvents([
      { type: 'chat_seen', at: '2026-09-07T09:30:00Z' },
      { type: 'chat_seen', at: '2026-09-07T11:00:00Z' },               // phone clock ahead → clamped
      { type: 'notification_opened', at: '2026-09-07T09:00:00Z', message_id: M1 },
      { type: 'tray_feedback', at: '2026-09-07T09:00:00Z', tray_item_id: T1, feedback: 'too_much' },
      { type: 'tray_feedback', at: '2026-09-07T09:00:00Z', tray_item_id: T1, feedback: 'meh' },   // bad feedback
      { type: 'notification_shown', at: '2026-09-07T09:00:00Z' },                                  // no target
      { type: 'bogus', at: '2026-09-07T09:00:00Z', message_id: M1 },                                // bad type
      { type: 'chat_seen', at: 'yesterday' },                                                       // bad time
      'not an object',
      { type: 'notification_opened', at: '2026-09-07T09:00:00Z', message_id: 'not-a-uuid' },       // id dropped → no target
    ], NOW);
    expect(rejected).toBe(6);
    expect(events.map((e) => e.type)).toEqual(['chat_seen', 'chat_seen', 'notification_opened', 'tray_feedback']);
    expect(events[1].at).toBe(NOW.toISOString());
    expect(events[3].feedback).toBe('too_much');
  });

  it('a non-array body yields nothing', () => {
    expect(normalizeEvents({ type: 'chat_seen' }, NOW)).toEqual({ events: [], rejected: 0 });
  });
});

describe('foldReadState — monotonic', () => {
  it('moves forward to the latest chat_seen and never backwards', () => {
    const { events } = normalizeEvents([
      { type: 'chat_seen', at: '2026-09-07T09:00:00Z' },
      { type: 'chat_seen', at: '2026-09-07T09:30:00Z' },
      { type: 'chat_seen', at: '2026-09-07T08:00:00Z' },
    ], NOW);
    expect(foldReadState(null, events)).toBe('2026-09-07T09:30:00.000Z');
    expect(foldReadState('2026-09-07T09:45:00.000Z', events)).toBe('2026-09-07T09:45:00.000Z');
  });

  it('no chat_seen → the current position stands', () => {
    const { events } = normalizeEvents([{ type: 'tray_opened', at: '2026-09-07T09:00:00Z', tray_item_id: T1 }], NOW);
    expect(foldReadState('2026-09-07T08:00:00.000Z', events)).toBe('2026-09-07T08:00:00.000Z');
    expect(foldReadState(null, events)).toBeNull();
  });
});

describe('reduceDeliveryEvents — first wins per target, feedback last wins', () => {
  it('folds a batch into one update per target', () => {
    const { events } = normalizeEvents([
      { type: 'notification_shown', at: '2026-09-07T09:00:00Z', message_id: M1 },
      { type: 'notification_opened', at: '2026-09-07T09:05:00Z', message_id: M1 },
      { type: 'notification_opened', at: '2026-09-07T09:02:00Z', message_id: M1 },   // earlier → wins
      { type: 'notification_dismissed', at: '2026-09-07T09:10:00Z', message_id: M1 },
      { type: 'tray_opened', at: '2026-09-07T09:20:00Z', tray_item_id: T1 },
      { type: 'tray_feedback', at: '2026-09-07T09:21:00Z', tray_item_id: T1, feedback: 'too_much' },
      { type: 'tray_feedback', at: '2026-09-07T09:22:00Z', tray_item_id: T1, feedback: 'ok' },
      { type: 'notification_shown', at: '2026-09-07T09:00:00Z', delivery_id: D1 },
      { type: 'chat_seen', at: '2026-09-07T09:30:00Z' },
    ], NOW);
    const updates = reduceDeliveryEvents(events);
    expect(updates).toHaveLength(3);
    const byMsg = updates.find((u) => u.target.message_id === M1)!;
    expect(byMsg.shown_at).toBe('2026-09-07T09:00:00.000Z');
    expect(byMsg.opened_at).toBe('2026-09-07T09:02:00.000Z');
    expect(byMsg.seen_at).toBe('2026-09-07T09:02:00.000Z');
    expect(byMsg.dismissed_at).toBe('2026-09-07T09:10:00.000Z');
    const byTray = updates.find((u) => u.target.tray_item_id === T1)!;
    expect(byTray.seen_at).toBe('2026-09-07T09:20:00.000Z');
    expect(byTray.feedback).toBe('ok');
    expect(updates.find((u) => u.target.delivery_id === D1)!.shown_at).toBe('2026-09-07T09:00:00.000Z');
  });

  it('is idempotent — the same batch twice folds to the same updates', () => {
    const { events } = normalizeEvents([{ type: 'notification_opened', at: '2026-09-07T09:05:00Z', message_id: M1 }], NOW);
    expect(reduceDeliveryEvents([...events, ...events])).toEqual(reduceDeliveryEvents(events));
  });
});

describe('deriveSeenAt — first of opened / tray_opened / read position passing the row', () => {
  const row = { created_at: '2026-09-07T09:00:00Z', seen_at: null };
  it('nothing reached it → null', () => {
    expect(deriveSeenAt(row, null)).toBeNull();
    expect(deriveSeenAt(row, '2026-09-07T08:59:00Z')).toBeNull();   // read position before the row
  });
  it('the read position at/after created_at marks it seen at the position time', () => {
    expect(deriveSeenAt(row, '2026-09-07T09:30:00Z')).toBe('2026-09-07T09:30:00.000Z');
    expect(deriveSeenAt(row, '2026-09-07T09:00:00Z')).toBe('2026-09-07T09:00:00.000Z');
  });
  it('an earlier open wins over a later read position, and an existing seen_at is kept', () => {
    expect(deriveSeenAt({ ...row, opened_at: '2026-09-07T09:10:00Z' }, '2026-09-07T09:30:00Z')).toBe('2026-09-07T09:10:00.000Z');
    expect(deriveSeenAt({ ...row, seen_at: '2026-09-07T09:05:00Z', opened_at: '2026-09-07T09:10:00Z' }, null)).toBe('2026-09-07T09:05:00.000Z');
  });
});

describe('unseenCount', () => {
  const rows = [
    { role: 'assistant', direction: 'outbound', created_at: '2026-09-07T08:00:00Z', metadata: { class: 'fyi' } },
    { role: 'assistant', direction: 'outbound', created_at: '2026-09-07T09:10:00Z', metadata: { class: 'needs-you', subject: 'x' } },
    { role: 'assistant', direction: 'outbound', created_at: '2026-09-07T09:20:00Z', metadata: { rail: true, kind: 'thinking', class: 'fyi' } }, // rail never counts
    { role: 'assistant', direction: 'outbound', created_at: '2026-09-07T09:30:00Z', metadata: { kind: 'thinking' } },                            // no class, no level
    { role: 'assistant', direction: 'outbound', created_at: '2026-09-07T09:40:00Z', metadata: { notification_level: 'notify' } },
    { role: 'user', direction: 'inbound', created_at: '2026-09-07T09:50:00Z', metadata: { class: 'fyi' } },
    { role: 'system', created_at: '2026-09-07T09:55:00Z', metadata: { scheduler: 'heartbeat', class: 'fyi' } },
  ];
  it('counts classed / levelled assistant rows after the read position, never rail rows', () => {
    expect(unseenCount(rows, '2026-09-07T09:00:00Z')).toBe(2);
    expect(unseenCount(rows, null)).toBe(3);
    expect(unseenCount(rows, '2026-09-07T09:40:00Z')).toBe(0);
  });
  it('countsAsUnseen spells the rule out', () => {
    expect(countsAsUnseen(rows[2])).toBe(false);
    expect(countsAsUnseen({ role: 'assistant', created_at: NOW, metadata: { rail: 'true', class: 'fyi' } })).toBe(false);
    expect(countsAsUnseen(rows[1])).toBe(true);
  });
});

describe('seenAgeText', () => {
  it('formats minutes / hours / days', () => {
    expect(seenAgeText(null, NOW)).toBeNull();
    expect(seenAgeText('2026-09-07T09:46:00Z', NOW)).toBe('14m');
    expect(seenAgeText('2026-09-07T07:00:00Z', NOW)).toBe('3h');
    expect(seenAgeText('2026-09-04T10:00:00Z', NOW)).toBe('3d');
  });
});
