import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

// Spy on the two side-effects the spine produces.
const insertSystemMessage = vi.fn(async () => 'msg-id');
const sendFCMNotification = vi.fn(async () => {});
vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage: (...a: unknown[]) => insertSystemMessage(...a),
  createSchedulerEvent: (name: string) => ({ scheduler: name, event_id: 'evt', fired_at: 'now' }),
}));
vi.mock('../utils/fcm-sender.js', () => ({
  sendFCMNotification: (...a: unknown[]) => sendFCMNotification(...a),
}));

import { raiseAlert, clearAlert } from '../utils/alerting.js';

const USER = 'u1';
const MIN = 60 * 1000;

/** Pool whose INSERT...RETURNING yields `firingRow`; everything else is a no-op. */
function poolReturning(firingRow: Record<string, unknown> | null) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('INSERT INTO system_alerts')) return { rows: firingRow ? [firingRow] : [] };
    if (sql.includes("status = 'resolved'")) return { rows: firingRow ? [firingRow] : [] };
    return { rows: [] };
  });
  return { query } as unknown as Pool;
}

const base = {
  id: 'a1', status: 'firing', severity: 'critical',
  first_seen_at: new Date(Date.now() - 90 * MIN).toISOString(),
  notify_count: 0,
};

describe('alerting spine — notification cadence', () => {
  beforeEach(() => { insertSystemMessage.mockClear(); sendFCMNotification.mockClear(); });

  it('first fire notifies the agent AND pushes the phone', async () => {
    const pool = poolReturning({ ...base, last_agent_notified_at: null, last_push_at: null });
    await raiseAlert(pool, { userId: USER, key: 'channel.whatsapp', severity: 'critical', summary: 'x' });
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(sendFCMNotification).toHaveBeenCalledTimes(1);
    // critical → FCM level critical
    expect(sendFCMNotification.mock.calls[0][2]).toMatchObject({ notification_level: 'critical' });
    // agent message carries the [ALERT] envelope
    expect(String(insertSystemMessage.mock.calls[0][2])).toContain('[ALERT]');
  });

  it('re-firing within the cadence does NOT re-notify the agent or re-push', async () => {
    const pool = poolReturning({
      ...base,
      last_agent_notified_at: new Date(Date.now() - 5 * MIN).toISOString(), // 5m ago < 20m
      last_push_at: new Date(Date.now() - 5 * MIN).toISOString(),           // 5m ago < 30m
    });
    await raiseAlert(pool, { userId: USER, key: 'channel.whatsapp', severity: 'critical', summary: 'x' });
    expect(insertSystemMessage).not.toHaveBeenCalled();
    expect(sendFCMNotification).not.toHaveBeenCalled();
  });

  it('a long-firing critical re-pushes the phone after the 30m re-notify window', async () => {
    // Agent cadence (DECISION-028 #7): the second agent notice comes at 6h into the
    // episode, not every 20 min; the phone's critical re-push cadence is unchanged.
    const pool = poolReturning({
      ...base,
      first_seen_at: new Date(Date.now() - 7 * 60 * MIN).toISOString(), // 7h episode → second notice due
      notify_count: 1,
      last_agent_notified_at: new Date(Date.now() - 7 * 60 * MIN).toISOString(),
      last_push_at: new Date(Date.now() - 35 * MIN).toISOString(),           // >30m → re-push (critical)
    });
    await raiseAlert(pool, { userId: USER, key: 'channel.whatsapp', severity: 'critical', summary: 'x' });
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(sendFCMNotification).toHaveBeenCalledTimes(1);
  });

  it('agent re-notify cadence: 20m→silent, 6h→second notice, then only every 24h (DECISION-028 #7)', async () => {
    // 25 min into the episode, already notified once → NOT due (the old 20-min cadence would fire).
    let pool = poolReturning({ ...base, notify_count: 1,
      first_seen_at: new Date(Date.now() - 25 * MIN).toISOString(),
      last_agent_notified_at: new Date(Date.now() - 25 * MIN).toISOString(), last_push_at: new Date().toISOString() });
    await raiseAlert(pool, { userId: USER, key: 'channel.gmail', severity: 'warning', summary: 'x' });
    expect(insertSystemMessage).not.toHaveBeenCalled();
    // Second notice sent (notify_count 2) 10h ago, episode 20h old → not yet 24h since → NOT due.
    pool = poolReturning({ ...base, notify_count: 2,
      first_seen_at: new Date(Date.now() - 20 * 60 * MIN).toISOString(),
      last_agent_notified_at: new Date(Date.now() - 10 * 60 * MIN).toISOString(), last_push_at: new Date().toISOString() });
    await raiseAlert(pool, { userId: USER, key: 'channel.gmail', severity: 'warning', summary: 'x' });
    expect(insertSystemMessage).not.toHaveBeenCalled();
    // 25h since the second notice → third notice due.
    pool = poolReturning({ ...base, notify_count: 2,
      first_seen_at: new Date(Date.now() - 40 * 60 * MIN).toISOString(),
      last_agent_notified_at: new Date(Date.now() - 25 * 60 * MIN).toISOString(), last_push_at: new Date().toISOString() });
    await raiseAlert(pool, { userId: USER, key: 'channel.gmail', severity: 'warning', summary: 'x' });
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('a long-firing WARNING re-notifies the agent but does NOT re-push the phone', async () => {
    const pool = poolReturning({
      ...base, severity: 'warning',
      first_seen_at: new Date(Date.now() - 7 * 60 * MIN).toISOString(),
      notify_count: 1,
      last_agent_notified_at: new Date(Date.now() - 7 * 60 * MIN).toISOString(),
      last_push_at: new Date(Date.now() - 35 * MIN).toISOString(),
    });
    await raiseAlert(pool, { userId: USER, key: 'channel.slack', severity: 'warning', summary: 'x' });
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(sendFCMNotification).not.toHaveBeenCalled(); // warning never re-pushes
  });

  it('clearAlert on a firing row tells the agent it recovered', async () => {
    const pool = poolReturning({ summary: 'WhatsApp ingestion stalled', first_seen_at: base.first_seen_at, last_push_at: null });
    await clearAlert(pool, USER, 'channel.whatsapp');
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(String(insertSystemMessage.mock.calls[0][2])).toContain('RESOLVED');
  });

  it('clearAlert is a no-op when nothing was firing', async () => {
    const pool = poolReturning(null); // UPDATE...RETURNING yields no row
    await clearAlert(pool, USER, 'channel.whatsapp');
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });
});
