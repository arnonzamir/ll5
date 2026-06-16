import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';

// Mock the alert spine so we can assert whether an alert was raised/cleared.
const raiseAlert = vi.fn(async () => {});
const clearAlert = vi.fn(async () => {});
vi.mock('../utils/alerting.js', () => ({
  raiseAlert: (...args: unknown[]) => raiseAlert(...args),
  clearAlert: (...args: unknown[]) => clearAlert(...args),
}));
// withSchedulerHealth just wraps the tick body; run it directly in tests.
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_name: string, fn: () => Promise<void>) => fn(),
}));

import { AgentOutputMonitor } from '../scheduler/agent-output-monitor.js';

const USER = 'test-user';
const HOUR_MS = 60 * 60 * 1000;

function makeConfig() {
  return {
    intervalMinutes: 15,
    minSystemInbound: 3,
    silenceHours: 0.5, // the live value that triggered the false alarms
    lookbackHours: 3,
    startHour: 0,
    endHour: 24, // always "active" so the alert path is exercised
    timezone: 'Asia/Jerusalem',
    userId: USER,
  };
}

/**
 * Mock pool: 1st query = system inbound COUNT, 2nd = MAX outbound timestamp.
 * `lastOutboundMsAgo` controls how long since the agent last produced chat.
 */
function makePool(systemInbound: number, lastOutboundMsAgo: number) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: systemInbound }] };
    if (sql.includes('MAX(created_at)')) {
      return { rows: [{ created_at: new Date(Date.now() - lastOutboundMsAgo) }] };
    }
    return { rows: [] };
  });
  return { query } as unknown as Pool;
}

/**
 * Mock ES count: returns 1 iff the query window (gte) reaches back far enough to
 * include a journal written `journalMsAgo` ago — i.e. simulates a real journal
 * doc at that age. This is exactly what the window-size bug hinges on.
 */
function makeEs(journalMsAgo: number) {
  const count = vi.fn(async (params: { query: { bool: { should: Array<{ range: { created_at?: { gte: string }; updated_at?: { gte: string } } }> } } }) => {
    const gteStr = params.query.bool.should[0]?.range.created_at?.gte;
    const gteMs = new Date(gteStr as string).getTime();
    const journalAt = Date.now() - journalMsAgo;
    return { count: journalAt >= gteMs ? 1 : 0 };
  });
  return { count } as unknown as Client;
}

async function runTick(monitor: AgentOutputMonitor) {
  await (monitor as unknown as { tick: () => Promise<void> }).tick();
}

describe('AgentOutputMonitor — journal-aware liveness window', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });

  it('does NOT alert when the agent journaled within the ~hourly cadence (45m ago), despite a 0.5h chat-silence threshold', async () => {
    // No chat outbound for 45m (> silenceHours 0.5h) and 8 triggers landed —
    // pre-fix this fired because the 0.5h journal window missed the 45m journal.
    const monitor = new AgentOutputMonitor(
      makePool(8, 45 * 60 * 1000),
      makeEs(45 * 60 * 1000),
      makeConfig(),
    );
    await runTick(monitor);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('STILL alerts when the agent is genuinely dead (no journal for 3h) while triggers pile up — failsafe preserved', async () => {
    const monitor = new AgentOutputMonitor(
      makePool(8, 3 * HOUR_MS),
      makeEs(3 * HOUR_MS), // last journal 3h ago — outside the 2h alive floor
      makeConfig(),
    );
    await runTick(monitor);
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert.mock.calls[0][1]).toMatchObject({ key: 'agent.output', severity: 'critical' });
  });

  it('does NOT alert when too few scheduler triggers landed (silence is organic)', async () => {
    const monitor = new AgentOutputMonitor(
      makePool(1, 3 * HOUR_MS), // only 1 trigger < minSystemInbound 3
      makeEs(3 * HOUR_MS),
      makeConfig(),
    );
    await runTick(monitor);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});
