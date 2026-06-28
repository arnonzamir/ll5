import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';

const raiseAlert = vi.fn(async () => {});
const clearAlert = vi.fn(async () => {});
vi.mock('../utils/alerting.js', () => ({
  raiseAlert: (...a: unknown[]) => raiseAlert(...a),
  clearAlert: (...a: unknown[]) => clearAlert(...a),
}));
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_n: string, fn: () => Promise<void>) => fn(),
}));

import { MCPHealthMonitorScheduler } from '../scheduler/mcp-health-monitor.js';

// es.search feeds computeErrorRates: by_service buckets of {key, doc_count(total), errors.doc_count}.
function esWithRates(rows: Array<{ service: string; total: number; errors: number }>): Client {
  return {
    search: vi.fn(async () => ({
      aggregations: { by_service: { buckets: rows.map((r) => ({ key: r.service, doc_count: r.total, errors: { doc_count: r.errors } })) } },
    })),
  } as unknown as Client;
}
// pool.query: the clear-stale sweep selects firing mcp.errors.* alerts.
function poolFiring(keys: string[]): Pool {
  return {
    query: vi.fn(async (sql: string) =>
      String(sql).includes('system_alerts') ? { rows: keys.map((k) => ({ alert_key: k })) } : { rows: [] },
    ),
  } as unknown as Pool;
}
const cfg = (mcpUrls: Record<string, string> = {}) => ({
  intervalMinutes: 2, mcpUrls, userId: 'u1', failureThreshold: 2,
  errorRateThreshold: 0.25, errorRateMinSamples: 10, authSecret: 'x', apiKey: 'y',
});
const tick = (m: MCPHealthMonitorScheduler) => (m as unknown as { tick: () => Promise<void> }).tick();

describe('MCPHealthMonitor — error-spike clear', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });

  it('clears a stuck mcp.errors alert when the service went quiet (no longer sampled)', async () => {
    // google is NOT in the current sample set at all (errored in a past burst, now quiet),
    // yet its alert is still firing in PG. The old code never reached a clear for it.
    const es = esWithRates([{ service: 'gtd', total: 30, errors: 0 }]);
    const m = new MCPHealthMonitorScheduler(poolFiring(['mcp.errors.google']), es, cfg());
    await tick(m);
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(clearAlert).toHaveBeenCalledWith(expect.anything(), 'u1', 'mcp.errors.google');
  });

  it('clears when a sampled service dropped below threshold', async () => {
    const es = esWithRates([{ service: 'google', total: 20, errors: 1 }]); // 5% < 25%
    const m = new MCPHealthMonitorScheduler(poolFiring(['mcp.errors.google']), es, cfg());
    await tick(m);
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(clearAlert).toHaveBeenCalledWith(expect.anything(), 'u1', 'mcp.errors.google');
  });

  it('keeps firing (does NOT clear) while the service is still spiking', async () => {
    const es = esWithRates([{ service: 'google', total: 20, errors: 10 }]); // 50% >= 25%
    const m = new MCPHealthMonitorScheduler(poolFiring(['mcp.errors.google']), es, cfg());
    await tick(m);
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(clearAlert).not.toHaveBeenCalledWith(expect.anything(), 'u1', 'mcp.errors.google');
  });
});
