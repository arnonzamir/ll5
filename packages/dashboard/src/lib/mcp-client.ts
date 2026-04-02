/**
 * MCP StreamableHTTP client for calling remote MCP tools.
 *
 * Each tool call performs the full initialize → notification → tools/call handshake
 * because the transport is stateless (no session persistence between requests).
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
  id: number = 1
): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
}

/** Parse SSE text to extract JSON-RPC responses. */
function parseSseResponse(text: string): JsonRpcResponse | null {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        return JSON.parse(data) as JsonRpcResponse;
      } catch (err) {
        console.error("[parseSseResponse] Failed to parse SSE data line:", data.slice(0, 200), err instanceof Error ? err.message : String(err));
      }
    }
  }
  return null;
}

async function mcpPost(
  serverUrl: string,
  body: JsonRpcRequest | { jsonrpc: "2.0"; method: string },
  token: string,
  sessionId?: string
): Promise<{ response: JsonRpcResponse | null; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const res = await fetch(`${serverUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const newSessionId = res.headers.get("mcp-session-id") ?? sessionId ?? null;

  if (!res.ok) {
    const text = await res.text().catch(() => "MCP request failed");
    throw new Error(`MCP error ${res.status}: ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  let parsed: JsonRpcResponse | null = null;

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    parsed = parseSseResponse(text);
  } else if (contentType.includes("application/json")) {
    parsed = (await res.json()) as JsonRpcResponse;
  }

  return { response: parsed, sessionId: newSessionId };
}

/**
 * Call an MCP tool on a remote server.
 *
 * Performs the full handshake:
 * 1. POST initialize
 * 2. POST notifications/initialized
 * 3. POST tools/call
 */
export async function callMcpTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  token: string
): Promise<McpToolResult> {
  // Step 1: Initialize
  const initReq = makeRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "ll5-dashboard", version: "0.1.0" },
  });
  const { response: initRes, sessionId } = await mcpPost(
    serverUrl,
    initReq,
    token
  );

  if (initRes?.error) {
    throw new Error(`MCP initialize error: ${initRes.error.message}`);
  }

  // Step 2: Send initialized notification
  await mcpPost(
    serverUrl,
    { jsonrpc: "2.0", method: "notifications/initialized" } as JsonRpcRequest,
    token,
    sessionId ?? undefined
  );

  // Step 3: Call the tool
  const callReq = makeRequest(
    "tools/call",
    { name: toolName, arguments: args },
    2
  );
  const { response: callRes } = await mcpPost(
    serverUrl,
    callReq,
    token,
    sessionId ?? undefined
  );

  if (callRes?.error) {
    throw new Error(`MCP tool error: ${callRes.error.message}`);
  }

  return (callRes?.result as McpToolResult) ?? { content: [] };
}

/** Extract text from an MCP tool result. */
export function extractText(result: McpToolResult): string {
  return result.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

/** Extract JSON from an MCP tool result — parses the first text content as JSON. */
export function extractJson<T = unknown>(result: McpToolResult): T {
  const text = extractText(result);
  return JSON.parse(text) as T;
}
