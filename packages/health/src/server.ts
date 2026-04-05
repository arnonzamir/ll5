import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import pg from 'pg';
import express from 'express';
import type { Request, Response } from 'express';
import { initAppLog, initAudit, withToolLogging } from '@ll5/shared';
import { tokenAuthMiddleware } from './auth-middleware.js';
import type { AuthenticatedRequest } from './auth-middleware.js';
import { loadEnv } from './utils/env.js';
import { logger, setLogLevel } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { ensureIndices } from './setup/indices.js';
import { runMigrations } from './utils/migration-runner.js';
import { registerAllTools } from './tools/index.js';
import { registerAdapter } from './clients/registry.js';
import { GarminAdapter } from './clients/garmin/index.js';

const { Pool } = pg;

// Per-request userId storage using a simple closure approach.
let currentUserId = '';

function getUserId(): string {
  return currentUserId;
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel as LogLevel);

  initAppLog({
    elasticsearchUrl: env.elasticsearchUrl,
    service: 'health',
    level: (env.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  });

  logger.info('[startServer][init] Starting health MCP server', {
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

  // Retry ES connection
  let esConnected = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await esClient.ping();
      esConnected = true;
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

  if (!esConnected) {
    throw new Error('Failed to connect to Elasticsearch after 10 attempts');
  }

  // Ensure ES indices exist
  await ensureIndices(esClient);
  logger.info('[startServer][init] Elasticsearch indices verified');

  // Initialize audit logging
  initAudit(env.elasticsearchUrl);

  // Initialize PostgreSQL pool
  const pool = new Pool({ connectionString: env.databaseUrl });

  // Retry PG connection
  let pgConnected = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      pgConnected = true;
      break;
    } catch (err) {
      logger.warn(`[startServer][connect] PostgreSQL connection attempt ${attempt}/10 failed`, {
        error: String(err),
      });
      if (attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  if (!pgConnected) {
    throw new Error('Failed to connect to PostgreSQL after 10 attempts');
  }

  // Run PG migrations
  await runMigrations(pool);
  logger.info('[startServer][init] PostgreSQL migrations completed');

  // Register health source adapters
  registerAdapter(new GarminAdapter(pool, env.encryptionKey));
  logger.info('[startServer][init] Health source adapters registered');

  // Create Express app
  const app = express();
  app.use(express.json());

  // Health endpoint
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await esClient.ping();
      const pgClient = await pool.connect();
      pgClient.release();
      res.json({ status: 'healthy', elasticsearch: 'connected', postgresql: 'connected' });
    } catch (err) {
      logger.error('[health][health] Health check failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: 'unhealthy' });
    }
  });

  // Auth middleware
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

      const reqServer = new McpServer({
        name: 'll5-health',
        version: '0.1.0',
      });
      withToolLogging(reqServer, getUserId);
      registerAllTools(reqServer, esClient, pool, getUserId, env.encryptionKey);
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
    await pool.end();
    await esClient.close();
    logger.info('[startServer][shutdown] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
