import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
