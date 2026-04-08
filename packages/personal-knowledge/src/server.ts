import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import express from 'express';
import type { Request, Response } from 'express';
import { tokenAuthMiddleware } from './auth-middleware.js';
import type { AuthenticatedRequest } from './auth-middleware.js';
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
import { initAppLog, initAudit, withToolLogging } from '@ll5/shared';

// Per-request userId storage using AsyncLocalStorage for proper request isolation.
const userStore = new AsyncLocalStorage<string>();

function getUserId(): string {
  const uid = userStore.getStore();
  if (!uid) throw new Error('No user context — request not wrapped in userStore.run()');
  return uid;
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel as LogLevel);

  initAppLog({
    elasticsearchUrl: env.elasticsearchUrl,
    service: 'personal-knowledge',
    level: (env.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  });

  logger.info('[startServer][init] Starting personal-knowledge MCP server', {
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
  logger.info('[startServer][init] Elasticsearch indices verified');

  // Initialize audit logging
  initAudit(env.elasticsearchUrl);

  // Create repositories
  const repos = {
    profile: new ElasticsearchProfileRepository(esClient),
    fact: new ElasticsearchFactRepository(esClient),
    person: new ElasticsearchPersonRepository(esClient),
    place: new ElasticsearchPlaceRepository(esClient),
    dataGap: new ElasticsearchDataGapRepository(esClient),
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
      logger.error('[knowledge][health] Health check failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: 'unhealthy', elasticsearch: 'disconnected' });
    }
  });

  // Auth middleware — supports token auth + legacy API key fallback
  const authMw = tokenAuthMiddleware({
    authSecret: env.authSecret,
    legacyApiKey: env.apiKey,
    legacyUserId: env.userId,
  });

  // MCP endpoint using StreamableHTTP transport (stateless — new transport per request)
  app.all('/mcp', authMw, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    await userStore.run(userId, async () => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        // Each request gets its own server+transport pair in stateless mode
        const reqServer = new McpServer({
          name: 'll5-personal-knowledge',
          version: '0.1.0',
        });
        withToolLogging(reqServer, getUserId);
        registerAllTools(reqServer, repos, getUserId);
        await reqServer.connect(transport);

        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error('[startServer][mcp] MCP request failed', { error: String(err) });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });
  });

  // Start HTTP server
  const server = app.listen(env.port, () => {
    logger.info(`[startServer][init] Server listening on port ${env.port}`);
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
