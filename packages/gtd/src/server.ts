import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import type { Request, Response } from 'express';
import { tokenAuthMiddleware, initAudit, initAppLog, withToolLogging } from '@ll5/shared';
import type { AuthenticatedRequest } from '@ll5/shared';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEnv } from './utils/env.js';
import { logger, setLogLevel } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { runMigrations } from './utils/migration-runner.js';
import { PostgresHorizonRepository } from './repositories/postgres/horizon.repository.js';
import { PostgresInboxRepository } from './repositories/postgres/inbox.repository.js';
import { registerAllTools } from './tools/index.js';

const { Pool } = pg;

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

  if (env.elasticsearchUrl) {
    initAppLog({
      elasticsearchUrl: env.elasticsearchUrl,
      service: 'gtd',
      level: (env.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
    });
  }

  logger.info('[startServer] Starting GTD MCP server', { port: env.port });

  // -------------------------------------------------------------------------
  // PostgreSQL connection pool
  // -------------------------------------------------------------------------
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: 10,
  });

  // Verify connectivity with retries (PG may not be ready yet in Docker)
  const maxRetries = 15;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      logger.info('[startServer] PostgreSQL connection established');
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) {
        logger.error('[startServer] Failed to connect to PostgreSQL after retries', { error: message, attempts: maxRetries });
        process.exit(1);
      }
      const code = (err as Record<string, unknown>).code;
      logger.warn(`[startServer] PostgreSQL not ready, retrying (${attempt}/${maxRetries})...`, { error: message || code || 'unknown' });
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // -------------------------------------------------------------------------
  // Run migrations
  // -------------------------------------------------------------------------
  await runMigrations(pool);

  // -------------------------------------------------------------------------
  // Repositories
  // -------------------------------------------------------------------------
  const horizonRepo = new PostgresHorizonRepository(pool);
  const inboxRepo = new PostgresInboxRepository(pool);

  const deps = { horizonRepo, inboxRepo, gatewayUrl: env.gatewayUrl, authSecret: env.authSecret || '' };

  // -------------------------------------------------------------------------
  // Express app with auth middleware
  // -------------------------------------------------------------------------
  const app = express();
  app.use(express.json());

  // Auth middleware — supports token auth + legacy API key fallback
  const authMw = tokenAuthMiddleware({
    authSecret: env.authSecret!,
    legacy: env.apiKey && env.userId ? { apiKey: env.apiKey, userId: env.userId } : undefined,
  });

  // Health endpoint (no auth required)
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT 1');
      if (result.rows.length > 0) {
        res.json({ status: 'ok', service: 'll5-gtd' });
      } else {
        res.status(503).json({ status: 'unhealthy', service: 'll5-gtd' });
      }
    } catch (err) {
      // Try to recover the pool by ending and recreating would be complex.
      // For now just report unhealthy — Docker will restart if needed.
      logger.error('[gtd][health] Health check failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: 'unhealthy', service: 'll5-gtd' });
    }
  });

  // MCP endpoint (stateless — new server+transport per request)
  app.all('/mcp', authMw, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    await userStore.run(userId, async () => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const mcpServer = new McpServer({
          name: 'll5-gtd',
          version: '0.1.0',
        });
        withToolLogging(mcpServer, getUserId);
        registerAllTools(mcpServer, deps, getUserId);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[startServer] MCP request failed', { error: message });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Initialize audit logging
  if (env.elasticsearchUrl) {
    initAudit(env.elasticsearchUrl);
    logger.info('[startServer] Audit logging enabled');
  }

  // Start listening
  // -------------------------------------------------------------------------
  const server = app.listen(env.port, () => {
    logger.info(`[startServer] GTD MCP server listening on port ${env.port}`);
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    logger.info(`[startServer] Received ${signal}, shutting down gracefully`);
    server.close(() => {
      logger.info('[startServer] HTTP server closed');
    });
    await pool.end();
    logger.info('[startServer] PostgreSQL pool closed');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}
