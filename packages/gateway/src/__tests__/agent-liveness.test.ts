import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const raiseAlert = vi.fn(async () => {});
const clearAlert = vi.fn(async () => {});
vi.mock('../utils/alerting.js', () => ({
  raiseAlert: (...a: unknown[]) => raiseAlert(...a),
  clearAlert: (...a: unknown[]) => clearAlert(...a),
}));

import {
  parseHeartbeatHealth,
  recordHeartbeatHealth,
  firingAlertKeys,
  PROCESS_DOWN_AFTER_MS,
} from '../utils/agent-liveness.js';

const USER = 'u1';
const MIN = 60 * 1000;

/** Pool whose UPDATE returns the given claude_down_since. */
function poolReturningDownSince(downSince: Date | null) {
  const query = vi.fn(async () => ({ rows: [{ claude_down_since: downSince }] }));
  return { pool: { query } as unknown as Pool, query };
}

describe('parseHeartbeatHealth', () => {
  it('returns null for the legacy empty heartbeat', () => {
    expect(parseHeartbeatHealth({})).toBeNull();
    expect(parseHeartbeatHealth(undefined)).toBeNull();
    expect(parseHeartbeatHealth({ claude_alive: 'yes' })).toBeNull();
  });

  it('normalises the payload (floors, clamps negatives, trims the session id)', () => {
    expect(parseHeartbeatHealth({ claude_alive: true, claude_uptime_s: 12.7, launches_10m: -1, session_id: 'abc' }))
      .toEqual({ claude_alive: true, claude_uptime_s: 12, launches_10m: 0, picker_visible: false, session_id: 'abc' });
    expect(parseHeartbeatHealth({ claude_alive: false })?.session_id).toBeNull();
  });
});

describe('recordHeartbeatHealth — ISS-027 process liveness', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });

  it('alive: stores health and clears both liveness alerts', async () => {
    const { pool, query } = poolReturningDownSince(null);
    await recordHeartbeatHealth(pool, USER, { claude_alive: true, claude_uptime_s: 300, launches_10m: 1, picker_visible: false, session_id: 's' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([USER, expect.stringContaining('"claude_alive":true'), true, false]);
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(clearAlert).toHaveBeenCalledWith(pool, USER, 'agent.process_down');
    expect(clearAlert).toHaveBeenCalledWith(pool, USER, 'agent.launch_loop');
    expect(clearAlert).toHaveBeenCalledWith(pool, USER, 'agent.picker_stuck');
  });

  it('alive but parked on a startup picker for 3+ minutes: raises agent.picker_stuck (ISS-029)', async () => {
    const now = Date.now();
    const query = vi.fn(async () => ({ rows: [{ claude_down_since: null, picker_since: new Date(now - 4 * MIN) }] }));
    const pool = { query } as unknown as Pool;
    await recordHeartbeatHealth(pool, USER, { claude_alive: true, claude_uptime_s: 300, launches_10m: 1, picker_visible: true, session_id: 's' }, now);
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert.mock.calls[0][1]).toMatchObject({ key: 'agent.picker_stuck', severity: 'critical', value: 'picker visible 4m' });
    // a picker seen for the first time this minute is not yet an alert
    raiseAlert.mockClear();
    const fresh = { query: vi.fn(async () => ({ rows: [{ claude_down_since: null, picker_since: new Date(now) }] })) } as unknown as Pool;
    await recordHeartbeatHealth(fresh, USER, { claude_alive: true, claude_uptime_s: 20, launches_10m: 1, picker_visible: true, session_id: 's' }, now);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('down for less than the grace period: no alert yet (a relaunch is in progress)', async () => {
    const now = Date.now();
    const { pool } = poolReturningDownSince(new Date(now - MIN));
    await recordHeartbeatHealth(pool, USER, { claude_alive: false, claude_uptime_s: 0, launches_10m: 1, picker_visible: false, session_id: null }, now);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('down past the grace period: raises agent.process_down critical', async () => {
    const now = Date.now();
    const { pool } = poolReturningDownSince(new Date(now - PROCESS_DOWN_AFTER_MS - MIN));
    await recordHeartbeatHealth(pool, USER, { claude_alive: false, claude_uptime_s: 0, launches_10m: 1, picker_visible: false, session_id: null }, now);
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert.mock.calls[0][1]).toMatchObject({ key: 'agent.process_down', severity: 'critical', value: 'down 4m' });
  });

  it('relaunch loop: raises agent.launch_loop even while a fresh claude is momentarily up', async () => {
    const { pool } = poolReturningDownSince(null);
    await recordHeartbeatHealth(pool, USER, { claude_alive: true, claude_uptime_s: 20, launches_10m: 4, picker_visible: false, session_id: 's' });
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert.mock.calls[0][1]).toMatchObject({ key: 'agent.launch_loop', severity: 'critical', value: '4 launches in 10m' });
    expect(clearAlert).toHaveBeenCalledWith(pool, USER, 'agent.process_down');
  });
});

describe('firingAlertKeys', () => {
  it('returns the firing keys, and an empty set (no suppression) when the query fails', async () => {
    const ok = { query: vi.fn(async () => ({ rows: [{ alert_key: 'agent.process_down' }] })) } as unknown as Pool;
    expect([...(await firingAlertKeys(ok, USER))]).toEqual(['agent.process_down']);
    const bad = { query: vi.fn(async () => { throw new Error('db down'); }) } as unknown as Pool;
    expect((await firingAlertKeys(bad, USER)).size).toBe(0);
  });
});
