import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A Zod raw shape: an object whose values are Zod schemas.
 * This matches what the MCP SDK expects for tool input schemas.
 */
export type ZodRawShape = Record<string, z.ZodTypeAny>;

export interface ToolDefinition<T extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: T;
  handler: ToolHandler;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  userId: string,
) => Promise<CallToolResult>;

export interface McpServerConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
  port?: number;
  authConfig: {
    apiKey: string;
    userId: string;
  };
}
