import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import pg from 'pg';
import express from 'express';
import type { Request, Response } from 'express';
import {
  runWithRequestContext,
  getContextUserId,
  initAppLog,
  initAudit,
  withToolLogging,
  tokenAuthMiddleware,
  HOME_TIMEZONE_FALLBACK,
} from '@ll5/shared';
import type { AuthenticatedRequest } from '@ll5/shared';
import { loadEnv } from './utils/env.js';
import { logger, setLogLevel } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { runMigrations } from './utils/migration-runner.js';
import { merchantSubKey } from './utils/keys.js';
import { createRepositories } from './repositories/postgres/index.js';
import { registry } from './adapters/registry.js';
import { OtpStore } from './otp.js';
import { SyncService } from './sync.js';
import { registerAllTools, REDACTED_RESULT_TOOLS } from './tools/index.js';
import { registerApiRoutes } from './routes/api.js';

const { Pool } = pg;

// Per-request correlation context (userId + request_id) lives in @ll5/shared (DECISION-012).
function getUserId(): string {
  const uid = getContextUserId();
  if (!uid) throw new Error('No user context — request not wrapped in runWithRequestContext()');
  return uid;
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel as LogLevel);

  initAppLog({
    elasticsearchUrl: env.elasticsearchUrl,
    service: 'connectors',
    level: (env.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  });
  initAudit(env.elasticsearchUrl);

  logger.info('[startServer][init] Starting connectors MCP server', { port: env.port, nodeEnv: env.nodeEnv });

  // PostgreSQL only — no Elasticsearch client (ES is used for the audit/app log fetch writers alone).
  const pool = new Pool({ connectionString: env.databaseUrl });
  let pgConnected = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      pgConnected = true;
      break;
    } catch (err) {
      logger.warn(`[startServer][connect] PostgreSQL connection attempt ${attempt}/10 failed`, { error: String(err) });
      if (attempt < 10) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!pgConnected) throw new Error('Failed to connect to PostgreSQL after 10 attempts');

  await runMigrations(pool);
  logger.info('[startServer][init] PostgreSQL migrations completed');

  const repos = createRepositories(pool, env.encryptionKey, merchantSubKey(env.encryptionKey));
  const otp = new OtpStore();
  const sync = new SyncService({ repos, registry, otp, getUserId });
  // Phase 0: no adapters registered. Ledger rows arrive via ingest_ledger_rows; events via POST /api/events.
  logger.info('[startServer][init] Connector adapters registered', { adapters: registry.list().map((a) => a.id) });

  const timeZone = process.env.TZ || HOME_TIMEZONE_FALLBACK;

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      client.release();
      res.json({ status: 'healthy', postgresql: 'connected', adapters: registry.list().length });
    } catch (err) {
      logger.error('[health][health] Health check failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: 'unhealthy' });
    }
  });

  // Auth middleware — supports token auth + legacy API key fallback (same as every MCP).
  const authMw = tokenAuthMiddleware({
    authSecret: env.authSecret!,
    legacy: env.apiKey && env.userId ? { apiKey: env.apiKey, userId: env.userId } : undefined,
  });

  // MCP endpoint using StreamableHTTP transport (stateless -- new transport per request)
  app.all('/mcp', authMw, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    await runWithRequestContext(
      {
        userId,
        sessionId: (req.headers['x-ll5-session-id'] as string) || undefined,
        traceId: (req.headers['x-ll5-trace-id'] as string) || undefined,
      },
      async () => {
        try {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const reqServer = new McpServer({ name: 'll5-connectors', version: '0.1.0' });
          withToolLogging(reqServer, getUserId, { redactResults: REDACTED_RESULT_TOOLS });
          registerAllTools(reqServer, { repos, sync, otp, getUserId, timeZone });
          await reqServer.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          logger.error('[startServer][mcp] MCP request failed', { error: String(err) });
          if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
        }
      },
    );
  });

  // REST for the gateway (events, scheduled pulls) and the dashboard (settings, credentials).
  registerApiRoutes(app, authMw, { repos, sync, merchantSubKeyHex: merchantSubKey(env.encryptionKey) });

  const server = app.listen(env.port, () => {
    logger.info(`[startServer][listen] Server listening on port ${env.port}`);
  });

  const shutdown = async () => {
    logger.info('[startServer][shutdown] Shutting down...');
    server.close();
    await pool.end();
    logger.info('[startServer][shutdown] Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
