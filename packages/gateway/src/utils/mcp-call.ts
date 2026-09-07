import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateToken } from '@ll5/shared';

/**
 * Server-side MCP tool call (streamable HTTP, `${baseUrl}/mcp`). Connects
 * per request — cheap, and it mirrors the narratives router + the MCP
 * health probe. Returns the parsed JSON of the first text content, or null.
 *
 * `authHeader` is the full `Authorization` value. A request handler forwards
 * the caller's own header; a scheduler mints a short-lived user token with
 * `userBearer` so the MCP scopes to the right user (the messaging and
 * awareness MCPs resolve the user from the token, so the universal API_KEY
 * is not enough there).
 */
export const INTERNAL_MCP_TIMEOUT_MS = 8000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callMcpTool(baseUrl: string, authHeader: string, tool: string, args: Record<string, unknown>): Promise<any> {
  const mcpUrl = `${baseUrl.replace(/\/$/, '')}/mcp`;
  let client: McpClient | null = null;
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: authHeader } },
    });
    client = new McpClient({ name: 'll5-gateway-internal', version: '0.1.0' }, { capabilities: {} });
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`mcp_timeout_${INTERNAL_MCP_TIMEOUT_MS}ms`)), INTERNAL_MCP_TIMEOUT_MS)),
    ]);
    const res = await Promise.race([
      client.callTool({ name: tool, arguments: args }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`mcp_timeout_${INTERNAL_MCP_TIMEOUT_MS}ms`)), INTERNAL_MCP_TIMEOUT_MS)),
    ]);
    const content = res.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { text }; }
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/** `Authorization` value for a server-initiated call on behalf of `userId` (1-day user token). */
export function userBearer(userId: string, authSecret: string): string {
  return `Bearer ${generateToken(userId, authSecret, 1, 'user')}`;
}
