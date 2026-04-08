import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import type { Request, Response } from 'express';
import { extractUserContext } from '../auth/api-key.js';
import { createLogger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import type { McpServerConfig } from './types.js';

export async function createMcpServer(config: McpServerConfig): Promise<{ start: () => Promise<void>; stop: () => Promise<void> }> {
  const logger = createLogger(config.name);
  const port = config.port ?? 3000;

  const server = new McpServer({
    name: config.name,
    version: config.version,
  });

  // Register tools using the MCP SDK's registerTool API
  for (const tool of config.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (params: Record<string, unknown>): Promise<CallToolResult> => {
        // For v1, we resolve the user from the configured auth
        // In a full setup, the userId would come from the authenticated session
        const userId = config.authConfig.userId;

        try {
          return await tool.handler(params, userId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          logger.error('[McpServer][toolHandler] Tool execution failed', { tool: tool.name, error: message });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
            isError: true,
          };
        }
      },
    );
  }

  const app = express();
  app.use(express.json());

  // Health endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: config.name,
      uptime: process.uptime(),
    });
  });

  // MCP endpoint with auth
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      // Authenticate
      const authHeader = req.headers.authorization;
      extractUserContext(authHeader, config.authConfig);

      // Create or reuse transport
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (req.method === 'POST') {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id: string) => {
            transports.set(id, transport);
          },
        });

        transport.onclose = () => {
          const id = [...transports.entries()].find(([, t]) => t === transport)?.[0];
          if (id) transports.delete(id);
        };

        await server.connect(transport);
      } else {
        res.status(400).json({ error: 'No active session' });
        return;
      }

      await transport.handleRequest(req, res, req.body as Record<string, unknown>);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        const message = err instanceof Error ? err.message : 'Internal server error';
        logger.error('[McpServer][handleRequest] Request failed', { error: message });
        res.status(500).json({ error: message });
      }
    }
  });

  let httpServer: ReturnType<typeof app.listen> | null = null;

  return {
    start: async () => {
      return new Promise<void>((resolve) => {
        httpServer = app.listen(port, () => {
          logger.info('[McpServer][start] Server started', { port });
          resolve();
        });
      });
    },
    stop: async () => {
      logger.info('[McpServer][stop] Shutting down');
      for (const transport of transports.values()) {
        await transport.close();
      }
      transports.clear();
      if (httpServer) {
        await new Promise<void>((resolve) => {
          httpServer!.close(() => resolve());
        });
      }
      logger.info('[McpServer][stop] Server stopped');
    },
  };
}
