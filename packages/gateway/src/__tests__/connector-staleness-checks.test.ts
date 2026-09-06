import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';

vi.mock('../utils/alerting.js', () => ({ raiseAlert: async () => {}, clearAlert: async () => {} }));
vi.mock('../utils/scheduler-health.js', () => ({ withSchedulerHealth: (_n: string, fn: () => Promise<void>) => fn() }));

import { AnomalyMonitor, buildConnectorChecks, CONNECTOR_EVENTS_MAX_MINUTES } from '../scheduler/anomaly-monitor.js';
import { recordConnectorEvent, resetConnectorLiveness } from '../connectors/liveness.js';

const mk = () => new AnomalyMonitor({} as Pool, {} as Client, { intervalMinutes: 15, userId: 'u1' });

describe('connector event-feed staleness checks (derived from CONNECTOR_CATALOG)', () => {
  beforeEach(() => resetConnectorLiveness());

  it('one check per phone-fed connector that has a package or SMS sender; 48 h; suppressed by channel.mirror', () => {
    const checks = buildConnectorChecks();
    const keys = checks.map((c) => c.key).sort();
    expect(keys).toEqual(['connector.cal.events', 'connector.clalit.events', 'connector.iec.events', 'connector.isracard.events', 'connector.max.events']);
    for (const c of checks) {
      expect(c.kind).toBe('staleness');
      expect(c.suppressedBy).toEqual(['channel.mirror']);
      expect((c as { maxMinutes: number }).maxMinutes).toBe(CONNECTOR_EVENTS_MAX_MINUTES);
      expect(CONNECTOR_EVENTS_MAX_MINUTES).toBe(48 * 60);
    }
    // bank has no packages/senders yet and municipality/home-assistant are not phone-fed
    expect(keys).not.toContain('connector.bank.events');
    expect(keys).not.toContain('connector.municipality.events');
    expect(keys).not.toContain('connector.home-assistant.events');
  });

  it('the checks are registered on the monitor', () => {
    const m = mk();
    const keys = (m as unknown as { checks: Array<{ key: string }> }).checks.map((c) => c.key);
    expect(keys).toContain('connector.cal.events');
    expect(keys).toContain('loop.narrative_consolidation');
  });

  it('age is null (unknown, never fires) until an event is seen, then the real age for that user only', async () => {
    const m = mk();
    expect(m.connectorEventAgeMinutes('cal')).toBeNull();
    recordConnectorEvent('u1', 'cal', Date.now() - 3 * 60 * 60_000);
    recordConnectorEvent('u2', 'max', Date.now());
    expect(Math.round(m.connectorEventAgeMinutes('cal')!)).toBe(180);
    expect(m.connectorEventAgeMinutes('max')).toBeNull();
    const cal = buildConnectorChecks().find((c) => c.key === 'connector.cal.events') as { ageMinutes: (m: AnomalyMonitor) => Promise<number | null> };
    expect(Math.round((await cal.ageMinutes(m))!)).toBe(180);
  });
});
