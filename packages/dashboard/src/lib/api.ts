/**
 * Server-side helpers for calling MCP tools from React Server Components and server actions.
 */

import { redirect } from "next/navigation";
import { getToken } from "./auth";
import { env } from "./env";
import { callMcpTool, extractJson, type McpToolResult } from "./mcp-client";

export type { McpToolResult };
export { extractJson, extractText } from "./mcp-client";

type McpServer = "gtd" | "knowledge" | "awareness";

const MCP_URLS: Record<McpServer, string> = {
  gtd: env.MCP_GTD_URL,
  knowledge: env.MCP_KNOWLEDGE_URL,
  awareness: env.MCP_AWARENESS_URL,
};

/**
 * Call an MCP tool with the current user's token.
 * Redirects to /login if no token is present.
 */
export async function mcpCall(
  server: McpServer,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult> {
  const token = await getToken();
  if (!token) {
    redirect("/login");
  }
  return callMcpTool(MCP_URLS[server], tool, args, token);
}

/**
 * Call an MCP tool and parse the result as JSON.
 */
export async function mcpCallJson<T = unknown>(
  server: McpServer,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await mcpCall(server, tool, args);
  return extractJson<T>(result);
}

/**
 * Try to call an MCP tool, returning null on failure instead of throwing.
 */
export async function mcpCallSafe(
  server: McpServer,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult | null> {
  try {
    return await mcpCall(server, tool, args);
  } catch {
    return null;
  }
}

/**
 * Try to call an MCP tool and parse JSON, returning null on failure.
 */
export async function mcpCallJsonSafe<T = unknown>(
  server: McpServer,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<T | null> {
  try {
    return await mcpCallJson<T>(server, tool, args);
  } catch {
    return null;
  }
}

/**
 * Call an MCP tool and extract an array from the wrapped response.
 * MCP tools return {items: [...], total: N} or {projects: [...]} etc.
 * This unwraps to just the array.
 */
export async function mcpCallList<T = unknown>(
  server: McpServer,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<T[]> {
  try {
    const raw = await mcpCallJson<Record<string, unknown>>(server, tool, args);
    if (Array.isArray(raw)) return raw as T[];
    // Find the first array value in the response
    for (const val of Object.values(raw ?? {})) {
      if (Array.isArray(val)) return val as T[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Check health of an MCP server by hitting its /health endpoint.
 */
export async function checkHealth(
  server: McpServer | "gateway"
): Promise<{ healthy: boolean; responseTime: number }> {
  const url = server === "gateway" ? env.GATEWAY_URL : MCP_URLS[server];
  const start = Date.now();
  try {
    const res = await fetch(`${url}/health`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(5000),
    });
    const responseTime = Date.now() - start;
    return { healthy: res.ok, responseTime };
  } catch {
    return { healthy: false, responseTime: Date.now() - start };
  }
}
