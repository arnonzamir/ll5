import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';

// DECISION-034 §5 — the scheduler's tick over a fake pool: which rung goes
// out, what is held by delivery mode, what expires. The rung arithmetic
// itself is covered in delivery-contract.test.ts.

const insertSystemMessage = vi.fn(async () => 'msg-id');
vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage: (...a: unknown[]) => insertSystemMessage(...a),
  createSchedulerEvent: (n: string) => ({ scheduler: n }),
}));
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_n: string, fn: () => Promise<void>) => fn(),
}));
vi.mock('../utils/timezone.js', () => ({
  getEffectiveTimezone: async () => 'Asia/Jerusalem',
}));
const sendFCMNotification = vi.fn(async () => undefined);
vi.mock('../utils/fcm-sender.js', () => ({
  sendFCMNotification: (...a: unknown[]) => sendFCMNotification(...a),
}));
let currentMode = 'normal';
vi.mock('../utils/delivery-mode.js', () => ({
  computeDeliveryMode: async () => ({ mode: currentMode, hold_pushes: currentMode === 'sleep' || currentMode === 'quiet_hours' }),
}));

import { DeliveryEscalationScheduler } from '../scheduler/delivery-escalation.js';
import { planRungs } from '../utils/delivery-contract.js';

const NOW = new Date('2026-09-07T06:00:00Z');
const SENT = new Date('2026-09-07T05:00:00Z');
const DUE = new Date('2026-09-07T07:00:00Z'); // ladder: 06:15 / 06:45 / 06:55 UTC

function deliveryRow(overrides: Record<string, unknown> = {}) {
  const rungs = planRungs('standard', SENT, DUE);
  return {
    id: 'd1', user_id: 'u1', message_id: 'm1', tray_item_id: 't1', class: 'do-by', subject: 'Card pickup',
    stakes: 'medium', due_at: DUE.toISOString(), modality: 'push_notify', delivery_mode: 'normal', ack_required: true,
    status: 'sent', acknowledged_at: null, done_at: null,
    escalation: { spec: 'standard', rungs, next_at: rungs[0].at, ladder_start: SENT.toISOString(), initial_push: 'sent' },
    rung_sent: 0, created_at: SENT.toISOString(), content: 'Card pickup, 17 HaNadiv — closes at 13:00.',
    ...overrides,
  };
}

function poolWith(rows: unknown[]) {
  const query = vi.fn(async (sql: string) => {
    if (/FROM message_delivery d\s+LEFT JOIN chat_messages m/.test(sql)) return { rows, rowCount: rows.length };
    if (/UPDATE message_delivery d/.test(sql)) return { rows: [], rowCount: 0 }; // held-initial release: none
    if (/UPDATE message_delivery/.test(sql)) return { rows: [], rowCount: 1 };
    if (/UPDATE tray_items/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as Pool, query };
}

const mk = (pool: Pool) => new DeliveryEscalationScheduler(pool, {} as Client, { userId: 'u1', timezone: 'Asia/Jerusalem', intervalMinutes: 5 });
const fcmData = () => sendFCMNotification.mock.calls.map((c) => (c as unknown[])[2] as { notification_level: string; data: Record<string, string> });

describe('DeliveryEscalationScheduler.tick', () => {
  beforeEach(() => { currentMode = 'normal'; sendFCMNotification.mockClear(); insertSystemMessage.mockClear(); });

  it('sends the first due rung with the contract FCM data and records it durably first', async () => {
    const { pool, query } = poolWith([deliveryRow()]);
    await mk(pool).tick(new Date('2026-09-07T06:16:00Z')); // re-push due 06:15
    expect(sendFCMNotification).toHaveBeenCalledTimes(1);
    const [push] = fcmData();
    expect(push.notification_level).toBe('alert');
    expect(push.data).toMatchObject({ message_id: 'm1', tray_item_id: 't1', class: 'do-by', rung: 'repush', collapse: 't1', subject: 'Card pickup', due_at: DUE.toISOString() });
    const upd = query.mock.calls.find((c) => /UPDATE message_delivery\s+SET rung_sent/.test(String(c[0])))!;
    expect(upd[1]).toEqual(expect.arrayContaining(['d1', 'u1', 1, 'repush', 0]));
    const tray = query.mock.calls.find((c) => /UPDATE tray_items SET escalation/.test(String(c[0])))!;
    expect(String(tray[1][3])).toBe('alarm 09:45 · reach 09:55'); // local (UTC+3) times of the rungs still ahead
  });

  it('holds a non-critical rung in quiet hours / sleep, but a critical one goes through', async () => {
    currentMode = 'quiet_hours';
    const held = poolWith([deliveryRow()]);
    await mk(held.pool).tick(new Date('2026-09-07T06:16:00Z'));
    expect(sendFCMNotification).not.toHaveBeenCalled();

    currentMode = 'sleep';
    const crit = poolWith([deliveryRow({ stakes: 'critical', escalation: { spec: 'standard', rungs: planRungs('standard', SENT, DUE, 'critical'), next_at: null, ladder_start: SENT.toISOString(), initial_push: 'sent' } })]);
    await mk(crit.pool).tick(new Date('2026-09-07T06:16:00Z'));
    expect(sendFCMNotification).toHaveBeenCalledTimes(1);
    expect(fcmData()[0].notification_level).toBe('critical');
  });

  it('does nothing before a rung is due, and skips a do-by whose initial push is still held', async () => {
    const early = poolWith([deliveryRow()]);
    await mk(early.pool).tick(NOW); // 06:00 — first rung 06:15
    expect(sendFCMNotification).not.toHaveBeenCalled();

    const heldInitial = poolWith([deliveryRow({ escalation: { ...deliveryRow().escalation, initial_push: 'held' } })]);
    await mk(heldInitial.pool).tick(new Date('2026-09-07T06:16:00Z'));
    expect(sendFCMNotification).not.toHaveBeenCalled();
  });

  it('the reach rung is FCM rung:reach only in Phase 1', async () => {
    const { pool } = poolWith([deliveryRow({ rung_sent: 2 })]);
    await mk(pool).tick(new Date('2026-09-07T06:56:00Z'));
    expect(fcmData()[0].data.rung).toBe('reach');
  });

  it('closes an unacknowledged ask at due + 30 min: do-by → missed, needs-you → expired, tray expired, one [Tray] missed line', async () => {
    const late = new Date('2026-09-07T07:31:00Z');
    const doBy = poolWith([deliveryRow({ rung_sent: 3 })]);
    await mk(doBy.pool).tick(late);
    const upd = doBy.query.mock.calls.find((c) => /UPDATE message_delivery SET status = \$3/.test(String(c[0])))!;
    expect(upd[1]).toEqual(['d1', 'u1', 'missed']);
    expect(doBy.query.mock.calls.some((c) => /UPDATE tray_items SET status = 'expired'/.test(String(c[0])))).toBe(true);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(String(insertSystemMessage.mock.calls[0][2])).toBe('[Tray] missed: Card pickup');
    expect(sendFCMNotification).not.toHaveBeenCalled();

    insertSystemMessage.mockClear();
    const needsYou = poolWith([deliveryRow({ class: 'needs-you', ack_required: false, escalation: null })]);
    await mk(needsYou.pool).tick(late);
    const upd2 = needsYou.query.mock.calls.find((c) => /UPDATE message_delivery SET status = \$3/.test(String(c[0])))!;
    expect(upd2[1]).toEqual(['d1', 'u1', 'expired']);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('an acknowledged do-by past grace leaves the tray quietly: no missed line, no status change', async () => {
    const { pool, query } = poolWith([deliveryRow({ status: 'acknowledged', acknowledged_at: NOW.toISOString() })]);
    await mk(pool).tick(new Date('2026-09-07T07:31:00Z'));
    expect(query.mock.calls.some((c) => /UPDATE message_delivery SET status/.test(String(c[0])))).toBe(false);
    expect(query.mock.calls.some((c) => /UPDATE tray_items SET status = 'expired'/.test(String(c[0])))).toBe(true);
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('survives message_delivery not existing yet (pre-migration deploy)', async () => {
    const query = vi.fn(async (sql: string) => {
      if (/message_delivery/.test(sql)) {
        const err = new Error('relation "message_delivery" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(mk({ query } as unknown as Pool).tick(NOW)).resolves.toBeUndefined();
    expect(sendFCMNotification).not.toHaveBeenCalled();
  });
});
