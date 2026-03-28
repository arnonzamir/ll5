import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { loadEnv } from './utils/env.js';
import { logger, setLogLevel } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { ensureIndices } from './setup/indices.js';
import { ElasticsearchProfileRepository } from './repositories/elasticsearch/profile.repository.js';
import { ElasticsearchFactRepository } from './repositories/elasticsearch/fact.repository.js';
import { ElasticsearchPersonRepository } from './repositories/elasticsearch/person.repository.js';
import { ElasticsearchPlaceRepository } from './repositories/elasticsearch/place.repository.js';
import { ElasticsearchDataGapRepository } from './repositories/elasticsearch/data-gap.repository.js';
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

  logger.info('Starting personal-knowledge MCP server', {
    port: env.port,
    nodeEnv: env.nodeEnv,
  });

  // Initialize Elasticsearch client
  const esClient = new ElasticsearchClient({
    node: env.elasticsearchUrl,
    ...(env.elasticsearchApiKey
      ? { auth: { apiKey: env.elasticsearchApiKey } }
      : {}),
  });

  // Ensure indices exist
  await ensureIndices(esClient);
  logger.info('Elasticsearch indices verified');

  // Create repositories
  const repos = {
    profile: new ElasticsearchProfileRepository(esClient),
    fact: new ElasticsearchFactRepository(esClient),
    person: new ElasticsearchPersonRepository(esClient),
    place: new ElasticsearchPlaceRepository(esClient),
    dataGap: new ElasticsearchDataGapRepository(esClient),
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

  // MCP endpoint using StreamableHTTP transport (stateless — new transport per request)
  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Each request gets its own server+transport pair in stateless mode
      const reqServer = new McpServer({
        name: 'll5-personal-knowledge',
        version: '0.1.0',
      });
      registerAllTools(reqServer, repos, getUserId);
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
