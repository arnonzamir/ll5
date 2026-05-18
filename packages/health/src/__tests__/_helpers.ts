import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { HealthSourceAdapter } from '../clients/adapter.js';

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

/** Parse the JSON from a tool response. */
export function parseToolResponse<T = unknown>(response: ToolResponse): T {
  return JSON.parse(response.content[0].text) as T;
}

/** Build a minimal mock @elastic/elasticsearch Client whose verbs are vi.fn()s. */
export function makeMockEsClient(overrides: Record<string, unknown> = {}): Client {
  return {
    index: vi.fn().mockResolvedValue({ _id: 'mock-id-1', result: 'created' }),
    search: vi.fn().mockResolvedValue({ hits: { hits: [], total: { value: 0 } }, aggregations: {} }),
    get: vi.fn().mockResolvedValue({ _id: 'mock-id-1', _source: {} }),
    update: vi.fn().mockResolvedValue({ result: 'updated' }),
    updateByQuery: vi.fn().mockResolvedValue({ updated: 0 }),
    ...overrides,
  } as unknown as Client;
}

/** Build a minimal mock pg.Pool whose query() returns the given rows (FIFO across calls). */
export function makeMockPool(rows: Record<string, unknown>[] = []): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

/**
 * Build a stub HealthSourceAdapter. All methods throw by default so tests
 * fail loudly if a method is invoked that wasn't stubbed. Override only what
 * the test exercises.
 */
export function makeMockAdapter(overrides: Partial<HealthSourceAdapter> = {}): HealthSourceAdapter {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`HealthSourceAdapter.${name} not stubbed for this test`);
  });
  return {
    sourceId: 'garmin',
    displayName: 'Garmin',
    connect: unimpl('connect'),
    disconnect: unimpl('disconnect'),
    getStatus: unimpl('getStatus'),
    fetchSleep: unimpl('fetchSleep'),
    fetchHeartRate: unimpl('fetchHeartRate'),
    fetchDailyStats: unimpl('fetchDailyStats'),
    fetchActivities: unimpl('fetchActivities'),
    fetchBodyComposition: unimpl('fetchBodyComposition'),
    fetchStress: unimpl('fetchStress'),
    ...overrides,
  } as HealthSourceAdapter;
}
