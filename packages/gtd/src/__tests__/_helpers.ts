import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';

/**
 * A pg.Pool mock that returns queued responses in FIFO order, one per
 * `pool.query()` call. This mirrors real DB behavior where each statement
 * sees the current state: e.g. a row deleted by the first DELETE is gone for
 * a second DELETE. Once the queue is exhausted, further calls resolve to an
 * empty result set (rows: [], rowCount: 0).
 *
 * Each queued entry may be an array of rows (rowCount inferred) or an explicit
 * { rows, rowCount } object.
 */
export type QueuedResult =
  | Array<Record<string, unknown>>
  | { rows: Array<Record<string, unknown>>; rowCount: number };

export function makeMockPool(responses: QueuedResult[] = []): {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
} {
  const queue = responses.map((r) =>
    Array.isArray(r) ? { rows: r, rowCount: r.length } : r,
  );
  const query = vi.fn(async () => queue.shift() ?? { rows: [], rowCount: 0 });
  const pool = { query } as unknown as Pool;
  return { pool, query };
}

export type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type ToolHandler = (params: Record<string, unknown>) => Promise<ToolResponse>;

/**
 * Build a stub McpServer that records every tool() registration.
 * Returns the map of tool name → handler so tests can invoke handlers directly.
 *
 * The Zod schema is intentionally NOT applied here — the McpServer SDK applies
 * it at the transport layer in real use. Tests that need schema validation
 * should construct invalid input and expect the handler to behave as the
 * underlying code does on bad shapes; the more important assertions are over
 * the repo calls and response envelopes.
 */
export function captureTools(register: (server: McpServer) => void): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  register(fakeServer);
  return tools;
}

/** Parse the JSON from a successful tool response. */
export function parseToolResponse<T = unknown>(response: ToolResponse): T {
  return JSON.parse(response.content[0].text) as T;
}

/** A shorthand for a vi.fn that asserts on the userId argument it received. */
export function spy<T extends (...args: never[]) => unknown>() {
  return vi.fn() as unknown as T & { mock: ReturnType<typeof vi.fn>['mock'] };
}
