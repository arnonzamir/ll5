import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
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
  if (!currentUserId) {
    throw new Error('No authenticated user in current request context');
  }
  return currentUserId;
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel as LogLevel);

  logger.info('Starting awareness MCP server', {
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
      logger.warn(`Elasticsearch connection attempt ${attempt}/10 failed`, {
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
  logger.info('Elasticsearch indices verified');

  // Create repositories
  const repos = {
    location: new ElasticsearchLocationRepository(esClient),
    message: new ElasticsearchMessageRepository(esClient),
    entityStatus: new ElasticsearchEntityStatusRepository(esClient),
    calendar: new ElasticsearchCalendarEventRepository(esClient),
    notableEvent: new ElasticsearchNotableEventRepository(esClient),
  };

  logger.info('Repositories initialized');

  // Create Express app
  const app = express();
  app.use(express.json());

  // Health endpoint
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await esClient.ping();
      res.json({ status: 'healthy', elasticsearch: 'connected' });
    } catch {
      res.status(503).json({ status: 'unhealthy', elasticsearch: 'disconnected' });
    }
  });

  // Auth middleware
  function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization' });
      return;
    }
    const key = authHeader.slice(7);
    if (key !== env.apiKey) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    // Set the user context for this request
    currentUserId = env.userId;
    next();
  }

  // MCP endpoint using StreamableHTTP transport (stateless -- new transport per request)
  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Each request gets its own server+transport pair in stateless mode
      const reqServer = new McpServer({
        name: 'll5-awareness',
        version: '0.1.0',
      });
      registerAllTools(reqServer, repos, getUserId, env.timezone);
      await reqServer.connect(transport);

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('MCP request failed', { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Start HTTP server
  const server = app.listen(env.port, () => {
    logger.info(`Server listening on port ${env.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    server.close();
    await esClient.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
