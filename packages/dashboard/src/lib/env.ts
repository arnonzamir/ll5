/** Server-side environment variables — only import in server components / route handlers. */

export const env = {
  MCP_GTD_URL: process.env.MCP_GTD_URL ?? "https://mcp-gtd.noninoni.click",
  MCP_KNOWLEDGE_URL:
    process.env.MCP_KNOWLEDGE_URL ?? "https://mcp-knowledge.noninoni.click",
  MCP_AWARENESS_URL:
    process.env.MCP_AWARENESS_URL ?? "https://mcp-awareness.noninoni.click",
  MCP_CALENDAR_URL:
    process.env.MCP_CALENDAR_URL ?? "https://mcp-google.noninoni.click",
  MCP_MESSAGING_URL:
    process.env.MCP_MESSAGING_URL ?? "https://mcp-messaging.noninoni.click",
  MCP_HEALTH_URL:
    process.env.MCP_HEALTH_URL ?? "https://mcp-health.noninoni.click",
  GATEWAY_URL: process.env.GATEWAY_URL ?? "https://gateway.noninoni.click",
  ELASTICSEARCH_URL: process.env.ELASTICSEARCH_URL ?? "http://elasticsearch:9200",
} as const;
