import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withToolLogging, auditResultFor } from '../mcp/logged-server.js';

/** A stub McpServer that records the (wrapped) handler each tool registers. */
function fakeServer(): { server: McpServer; handlers: Map<string, (...a: unknown[]) => Promise<unknown>> } {
  const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as (...a: unknown[]) => Promise<unknown>);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

describe('withToolLogging redactResults option', () => {
  it('auditResultFor replaces only the named tools\' results with a marker', () => {
    const redacted = new Set(['query_events', 'query_ledger']);
    const payload = { events: [{ amount: 214.9, merchant: 'x' }] };
    expect(auditResultFor('query_events', payload, redacted)).toEqual({ redacted: true });
    expect(auditResultFor('list_connectors', payload, redacted)).toBe(payload);
    expect(auditResultFor('query_events', payload, new Set())).toBe(payload);
  });

  // The stub's tool() takes untyped args — the SDK overloads are irrelevant here.
  const tool = (s: McpServer) => s.tool as unknown as (...a: unknown[]) => unknown;

  it('the caller still receives the full result from a redacted tool', async () => {
    const { server, handlers } = fakeServer();
    withToolLogging(server, () => 'user-1', { redactResults: ['query_events'] });
    const full = { content: [{ type: 'text', text: '{"events":[1,2,3]}' }] };
    tool(server)('query_events', 'desc', {}, async () => full);
    tool(server)('list_connectors', 'desc', {}, async () => ({ ok: true }));
    expect(await handlers.get('query_events')!({ limit: 3 })).toBe(full);
    expect(await handlers.get('list_connectors')!({})).toEqual({ ok: true });
  });

  it('is a no-op for callers that pass no options (default behaviour kept)', async () => {
    const { server, handlers } = fakeServer();
    withToolLogging(server, () => 'user-1');
    tool(server)('read_journal', 'desc', {}, async (a: unknown) => ({ echoed: a }));
    expect(await handlers.get('read_journal')!({ limit: 1 })).toEqual({ echoed: { limit: 1 } });
  });
});
