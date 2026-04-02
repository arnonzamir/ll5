import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import express from 'express';
import type { Request, Response } from 'express';
import { initAppLog, withToolLogging } from '@ll5/shared';
import { tokenAuthMiddleware } from './auth-middleware.js';
import type { AuthenticatedRequest } from './auth-middleware.js';
import { loadEnv } from './utils/env.js';
import { logger, setLogLevel } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { ensureIndices } from './setup/indices.js';
import { ElasticsearchLocationRepository } from './repositories/elasticsearch/location.repository.js';
import { ElasticsearchMessageRepository } from './repositories/elasticsearch/message.repository.js';
import { ElasticsearchEntityStatusRepository } from './repositories/elasticsearch/entity-status.repository.js';
import { ElasticsearchCalendarEventRepository } from './repositories/elasticsearch/calendar-event.repository.js';
import { ElasticsearchNotableEventRepository } from './repositories/elasticsearch/notable-event.repository.js';
import { registerAllTools } from './tools/index.js';

// Per-request userId storage using a simple closure approach.
// In production this would use AsyncLocalStorage for proper request isolation.
let currentUserId = '';

function getUserId(): string {
  return currentUserId;
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel as LogLevel);

  initAppLog({
    elasticsearchUrl: env.elasticsearchUrl,
    service: 'awareness',
    level: (env.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  });

  logger.info('[startServer][init] Starting awareness MCP server', {
    port: env.port,
    nodeEnv: env.nodeEnv,
    timezone: env.timezone,
  });

  // Initialize Elasticsearch client
  const esClient = new ElasticsearchClient({
    node: env.elasticsearchUrl,
    ...(env.elasticsearchApiKey
      ? { auth: { apiKey: env.elasticsearchApiKey } }
      : {}),
  });

  // Retry ES connection (same pattern as other MCPs)
  let connected = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await esClient.ping();
      connected = true;
      break;
    } catch (err) {
      logger.warn(`[startServer][connect] Elasticsearch connection attempt ${attempt}/10 failed`, {
        error: String(err),
      });
      if (attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  if (!connected) {
    throw new Error('Failed to connect to Elasticsearch after 10 attempts');
  }

  // Ensure indices exist
  await ensureIndices(esClient);
  logger.info('[startServer][init] Elasticsearch indices verified');

  // Create repositories
  const repos = {
    location: new ElasticsearchLocationRepository(esClient),
    message: new ElasticsearchMessageRepository(esClient),
    entityStatus: new ElasticsearchEntityStatusRepository(esClient),
    calendar: new ElasticsearchCalendarEventRepository(esClient),
    notableEvent: new ElasticsearchNotableEventRepository(esClient),
  };

  logger.info('[startServer][init] Repositories initialized');

  // Create Express app
  const app = express();
  app.use(express.json());

  // Health endpoint
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await esClient.ping();
      res.json({ status: 'healthy', elasticsearch: 'connected' });
    } catch (err) {
      logger.error('[awareness][health] Health check failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: 'unhealthy', elasticsearch: 'disconnected' });
    }
  });

  // Auth middleware — supports token auth + legacy API key fallback
  const authMw = tokenAuthMiddleware({
    authSecret: env.authSecret,
    legacyApiKey: env.apiKey,
    legacyUserId: env.userId,
  });

  // MCP endpoint using StreamableHTTP transport (stateless -- new transport per request)
  app.all('/mcp', authMw, async (req: Request, res: Response) => {
    currentUserId = (req as AuthenticatedRequest).userId;
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Each request gets its own server+transport pair in stateless mode
      const reqServer = new McpServer({
        name: 'll5-awareness',
        version: '0.1.0',
      });
      withToolLogging(reqServer, getUserId);
      registerAllTools(reqServer, repos, getUserId, env.timezone, env.gatewayUrl, env.authSecret, esClient);
      await reqServer.connect(transport);

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('[startServer][mcp] MCP request failed', { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Start HTTP server
  const server = app.listen(env.port, () => {
    logger.info(`[startServer][listen] Server listening on port ${env.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('[startServer][shutdown] Shutting down...');
    server.close();
    await esClient.close();
    logger.info('[startServer][shutdown] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
