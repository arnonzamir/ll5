import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReconcileTools } from '../tools/reconcile.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface Registered {
  name: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

/** Capture the tools a register* call wires up. */
function captureServer(): { server: McpServer; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    tool: (name: string, _desc: string, schema: Record<string, unknown>, handler: Registered['handler']) => {
      tools.set(name, { name, schema, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

function makeEs(lastByConv: Record<string, string>): Client {
  return {
    search: vi.fn(async () => ({
      aggregations: { by_conv: { buckets: Object.entries(lastByConv).map(([key, ts]) => ({ key, last: { value_as_string: ts } })) } },
    })),
  } as unknown as Client;
}

describe('registerReconcileTools — tool surface + tenant scoping', () => {
  it('registers exactly list_reconcile_work + reconcile_loop; no write/send/pay/delete tools', () => {
    const { server, tools } = captureServer();
    registerReconcileTools(server, {} as Pool, makeEs({}), () => 'ctx-user');
    expect([...tools.keys()].sort()).toEqual(['list_reconcile_work', 'reconcile_loop']);
  });

  it('list_reconcile_work takes NO input args (tenant from context only)', () => {
    const { server, tools } = captureServer();
    registerReconcileTools(server, {} as Pool, makeEs({}), () => 'ctx-user');
    expect(Object.keys(tools.get('list_reconcile_work')!.schema)).toEqual([]);
  });

  it('list_reconcile_work uses getUserId() — an injected userId param is ignored', async () => {
    const { server, tools } = captureServer();
    const seenUserIds: string[] = [];
    const pool = {
      query: vi.fn(async (_sql: string, params: unknown[]) => {
        seenUserIds.push(params[0] as string);
        return { rows: [] };
      }),
    } as unknown as Pool;
    registerReconcileTools(server, pool, makeEs({}), () => 'ctx-user');
    // Pass a hostile userId param — it must be ignored; getUserId() wins.
    const res = await tools.get('list_reconcile_work')!.handler({ userId: 'attacker', user_id: 'attacker' } as Record<string, unknown>);
    expect(seenUserIds).toEqual(['ctx-user']);
    expect(JSON.parse(res.content[0].text)).toEqual({ candidates: [], missed_close_count: 0 });
  });

  it('reconcile_loop uses getUserId() for scoping — injected userId param ignored', async () => {
    const { server, tools } = captureServer();
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT stakes')) {
          expect(params![1]).toBe('ctx-user'); // scoped to context user, not param
          return { rowCount: 1, rows: [{ stakes: 'low' }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    registerReconcileTools(server, pool, makeEs({}), () => 'ctx-user');
    const res = await tools.get('reconcile_loop')!.handler({ loop_id: 'l1', action: 'close', userId: 'attacker' } as Record<string, unknown>);
    expect(JSON.parse(res.content[0].text)).toEqual({ result: 'closed' });
  });

  it('reconcile_loop exposes only loop_id + action (no arbitrary write fields)', () => {
    const { server, tools } = captureServer();
    registerReconcileTools(server, {} as Pool, makeEs({}), () => 'ctx-user');
    expect(Object.keys(tools.get('reconcile_loop')!.schema).sort()).toEqual(['action', 'loop_id']);
  });

  it('list_reconcile_work never throws even if the selector rejects (best-effort tool)', async () => {
    const { server, tools } = captureServer();
    const pool = { query: vi.fn(async () => { throw new Error('pg exploded'); }) } as unknown as Pool;
    // Selector already swallows the pg error; the tool wrapper is belt-and-suspenders.
    const res = await (async () => {
      registerReconcileTools(server, pool, makeEs({}), () => 'ctx-user');
      return tools.get('list_reconcile_work')!.handler({});
    })();
    expect(JSON.parse(res.content[0].text)).toEqual({ candidates: [], missed_close_count: 0 });
  });
});
