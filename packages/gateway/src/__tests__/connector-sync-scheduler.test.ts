/**
 * ConnectorSyncScheduler — one pass over the ledger connectors against a fake
 * connectors client; alerts are observed through an in-memory alert store
 * (state, not call assertions).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { CONNECTOR_CATALOG } from '@ll5/shared';

const alerts = new Map<string, { severity: string; summary: string; value?: string }>();
vi.mock('../utils/alerting.js', () => ({
  raiseAlert: async (_pool: unknown, input: { key: string; severity: string; summary: string; value?: string }) => {
    alerts.set(input.key, { severity: input.severity, summary: input.summary, value: input.value });
  },
  clearAlert: async (_pool: unknown, _userId: string, key: string) => {
    alerts.delete(key);
  },
}));
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_n: string, fn: () => Promise<unknown>) => fn(),
}));

import { ConnectorSyncScheduler, scheduledSyncTargets, SILENT_SYNC_REASONS, alertKeyFor } from '../scheduler/connector-sync.js';
import type { ConnectorsClient, ConnectorSyncResponse } from '../connectors/client.js';

const pool = {} as Pool;
const USER = 'u-sync';

function fakeClient(answer: (connectorId: string) => ConnectorSyncResponse | Error) {
  const calls: Array<{ userId: string; connectorId: string; scheduled: boolean }> = [];
  const client: ConnectorsClient = {
    baseUrl: 'http://connectors.test',
    postEvent: async () => ({ id: 'x', created: true }),
    postSync: async (userId, connectorId, opts) => {
      calls.push({ userId, connectorId, scheduled: opts?.scheduled === true });
      const a = answer(connectorId);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { client, calls };
}

beforeEach(() => alerts.clear());

describe('scheduledSyncTargets', () => {
  it('is every catalog entry with a ledger feed and a default cadence (financy included, event-only ones excluded)', () => {
    const targets = scheduledSyncTargets();
    expect(targets).toContain('financy');
    for (const id of targets) {
      const c = CONNECTOR_CATALOG.find((x) => x.id === id)!;
      expect(c.kinds).toContain('ledger');
      expect(c.default_schedule_minutes).not.toBeNull();
    }
    for (const c of CONNECTOR_CATALOG) {
      if (!c.kinds.includes('ledger') || c.default_schedule_minutes == null) expect(targets).not.toContain(c.id);
    }
  });
});

describe('ConnectorSyncScheduler.run', () => {
  it('posts scheduled:true for every target as the user and counts ok / not_due / silent refusals', async () => {
    const { client, calls } = fakeClient((id) => {
      if (id === 'financy') return { ok: true, connector_id: id, pulled: 3 };
      if (id === 'home-assistant') return { ok: false, connector_id: id, reason: 'not_due' };
      return { ok: false, connector_id: id, reason: 'no_adapter' };
    });
    const s = new ConnectorSyncScheduler(pool, { userId: USER }, client);
    const counts = await s.run();
    expect(counts).toEqual({ attempted: scheduledSyncTargets().length, synced: 1, not_due: 1, skipped: scheduledSyncTargets().length - 2, failed: 0 });
    expect(calls.every((c) => c.userId === USER && c.scheduled)).toBe(true);
    expect(calls.map((c) => c.connectorId).sort()).toEqual([...scheduledSyncTargets()].sort());
    expect(alerts.size).toBe(0);
  });

  it('raises connector.<id>.sync (warning) on a real failure and clears it on the next success', async () => {
    let failing = true;
    const { client } = fakeClient((id) => {
      if (id !== 'financy') return { ok: false, connector_id: id, reason: 'no_credentials' };
      return failing
        ? { ok: false, connector_id: id, reason: 'pull_failed', status: 'auth_failed', error: 'Financy rejected the client credentials (401)' }
        : { ok: true, connector_id: id, pulled: 0 };
    });
    const s = new ConnectorSyncScheduler(pool, { userId: USER }, client);
    expect(await s.run()).toMatchObject({ failed: 1, skipped: scheduledSyncTargets().length - 1 });
    const key = alertKeyFor('financy');
    expect(key).toBe('connector.financy.sync');
    expect(alerts.get(key)).toMatchObject({ severity: 'warning', value: 'auth_failed: Financy rejected the client credentials (401)' });
    expect(alerts.get(key)?.summary).toContain('financy');

    failing = false;
    expect(await s.run()).toMatchObject({ synced: 1, failed: 0 });
    expect(alerts.has(key)).toBe(false);
  });

  it('plan_not_eligible and rate_limited count as failures; the silent set is exactly the four quiet reasons', async () => {
    const { client } = fakeClient((id) => {
      if (id === 'financy') return { ok: false, connector_id: id, reason: 'pull_failed', status: 'error', code: 'plan_not_eligible', error: 'not on plan' };
      if (id === 'home-assistant') return { ok: false, connector_id: id, reason: 'rate_limited', retry_after_seconds: 30 };
      return { ok: false, connector_id: id, reason: 'disabled' };
    });
    const s = new ConnectorSyncScheduler(pool, { userId: USER }, client);
    expect(await s.run()).toMatchObject({ failed: 2 });
    expect(alerts.get('connector.financy.sync')?.value).toBe('plan_not_eligible: not on plan');
    expect(alerts.has('connector.bank.sync')).toBe(true);
    expect([...SILENT_SYNC_REASONS].sort()).toEqual(['disabled', 'no_adapter', 'no_credentials', 'not_due']);
  });

  it('an unreachable service fails the whole tick (health registry) without per-connector alerts', async () => {
    const { client } = fakeClient(() => new Error('fetch failed'));
    const s = new ConnectorSyncScheduler(pool, { userId: USER }, client);
    await expect(s.run()).rejects.toThrow(/unreachable/);
    expect(alerts.size).toBe(0);
  });

  it('start() is a no-op when disabled by settings', () => {
    const { client, calls } = fakeClient(() => ({ ok: true, connector_id: 'x' }));
    const s = new ConnectorSyncScheduler(pool, { userId: USER, enabled: false }, client);
    s.start();
    s.stop();
    expect(calls).toEqual([]);
  });
});
