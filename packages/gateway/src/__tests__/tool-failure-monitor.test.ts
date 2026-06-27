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
  withSchedulerHealth: (_name: string, fn: () => Promise<void>) => fn(),
}));

import { ToolFailureMonitor } from '../scheduler/tool-failure-monitor.js';

function esWithTools(tools: Array<{ tool: string; total: number; fails: number; err?: string }>): Client {
  return {
    search: vi.fn(async () => ({
      aggregations: {
        tools: {
          buckets: tools.map((t) => ({
            key: t.tool,
            doc_count: t.total,
            fails: {
              doc_count: t.fails,
              sample: { hits: { hits: t.err ? [{ _source: { error_message: t.err } }] : [] } },
            },
          })),
        },
      },
    })),
  } as unknown as Client;
}

const pool = {} as Pool;
const cfg = { intervalMinutes: 15, userId: 'u1', windowMinutes: 60, minFailures: 4, minRatio: 0.5 };
const mk = (es: Client) => new ToolFailureMonitor(pool, es, { ...cfg });
const tick = (m: ToolFailureMonitor) => (m as unknown as { tick: () => Promise<void> }).tick();
const arg = (n: number) => raiseAlert.mock.calls[n][1] as Record<string, unknown>;

describe('ToolFailureMonitor', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });

  it('alerts a tool failing the majority of its calls (>= minFailures AND ratio)', async () => {
    await tick(mk(esWithTools([{ tool: 'inspect_image', total: 6, fails: 6, err: "Cannot read properties of undefined" }])));
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(arg(0).key).toBe('tool.inspect_image');
    expect(arg(0).value).toContain('6/6');
    expect(String(arg(0).value)).toContain('Cannot read properties');
  });

  it('does NOT alert a high-traffic tool with a low failure ratio', async () => {
    await tick(mk(esWithTools([{ tool: 'recall', total: 100, fails: 4 }]))); // ratio 0.04
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('does NOT alert below minFailures even at ratio 1.0', async () => {
    await tick(mk(esWithTools([{ tool: 'foo', total: 2, fails: 2 }]))); // only 2 fails
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('escalates delivery/perception-critical tools to critical, others to warning', async () => {
    await tick(mk(esWithTools([
      { tool: 'push_to_user', total: 5, fails: 5 },
      { tool: 'note_observation', total: 5, fails: 5 },
    ])));
    const bySeverity = Object.fromEntries(
      raiseAlert.mock.calls.map((c) => [(c[1] as { key: string }).key, (c[1] as { severity: string }).severity]),
    );
    expect(bySeverity['tool.push_to_user']).toBe('critical');
    expect(bySeverity['tool.note_observation']).toBe('warning');
  });

  it('clears a tool alert once it recovers', async () => {
    const m = mk(esWithTools([{ tool: 'inspect_image', total: 5, fails: 5 }]));
    await tick(m);
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    // Same tool, now healthy → should clear on the next tick.
    (m as unknown as { es: Client }).es = esWithTools([{ tool: 'inspect_image', total: 5, fails: 0 }]);
    await tick(m);
    expect(clearAlert).toHaveBeenCalledWith(pool, 'u1', 'tool.inspect_image');
  });
});
