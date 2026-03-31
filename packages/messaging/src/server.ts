import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEnv } from './utils/env.js';
import { logger, setLogLevel } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { runMigrations } from './utils/migration-runner.js';
import { PostgresAccountRepository } from './repositories/postgres/account.repository.js';
import { PostgresConversationRepository } from './repositories/postgres/conversation.repository.js';
import { PostgresContactRepository } from './repositories/postgres/contact.repository.js';
import { registerAllTools } from './tools/index.js';

const { Pool } = pg;

// User ID resolved per-request via auth middleware
let currentUserId: string = '';

function getUserId(): string {
  return currentUserId;
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel as LogLevel);

  logger.info('Starting Messaging MCP server', { port: env.port });

  // ---------------------------------------------------------------------------
  // PostgreSQL connection pool
  // ---------------------------------------------------------------------------
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
      logger.info('PostgreSQL connection established');
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) {
        logger.error('Failed to connect to PostgreSQL after retries', { error: message, attempts: maxRetries });
        process.exit(1);
      }
      const code = (err as Record<string, unknown>).code;
      logger.warn(`PostgreSQL not ready, retrying (${attempt}/${maxRetries})...`, { error: message || code || 'unknown' });
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // ---------------------------------------------------------------------------
  // Run migrations
  // ---------------------------------------------------------------------------
  await runMigrations(pool);

  // ---------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------
  const accountRepo = new PostgresAccountRepository(pool, env.encryptionKey);
  const conversationRepo = new PostgresConversationRepository(pool);
  const contactRepo = new PostgresContactRepository(pool);

  const deps = { accountRepo, conversationRepo, contactRepo, encryptionKey: env.encryptionKey };

  // ---------------------------------------------------------------------------
  // Express app with auth middleware
  // ---------------------------------------------------------------------------
  const app = express();
  app.use(express.json());

  // Auth middleware — accepts ll5 signed tokens or legacy API key
  function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization' });
      return;
    }

    const bearer = authHeader.slice(7);

    // Try ll5 signed token first
    if (bearer.startsWith('ll5.')) {
      const parts = bearer.split('.');
      if (parts.length === 3) {
        const [, payloadB64, signature] = parts;
        try {
          const authSecret = process.env.AUTH_SECRET;
          if (authSecret) {
            const expected = crypto.createHmac('sha256', authSecret)
              .update(payloadB64).digest('hex').slice(0, 32);
            if (signature.length === 32 &&
                crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
              const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
              if (payload.exp > Date.now() / 1000) {
                currentUserId = payload.uid;
                next();
                return;
              }
              res.status(401).json({ error: 'token_expired' });
              return;
            }
          }
        } catch { /* fall through to legacy check */ }
      }
    }

    // Legacy API key fallback
    if (bearer === env.apiKey) {
      currentUserId = env.userId;
      next();
      return;
    }

    res.status(401).json({ error: 'Invalid credentials' });
  }

  // Health endpoint (no auth required)
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT 1');
      if (result.rows.length > 0) {
        res.json({ status: 'ok', service: 'll5-messaging' });
      } else {
        res.status(503).json({ status: 'unhealthy', service: 'll5-messaging' });
      }
    } catch {
      res.status(503).json({ status: 'unhealthy', service: 'll5-messaging' });
    }
  });

  // MCP endpoint (stateless -- new server+transport per request)
  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = new McpServer({
        name: 'll5-messaging',
        version: '0.1.0',
      });
      registerAllTools(mcpServer, deps, getUserId);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('MCP request failed', { error: message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Start listening
  // ---------------------------------------------------------------------------
  const server = app.listen(env.port, () => {
    logger.info(`Messaging MCP server listening on port ${env.port}`);
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    server.close(() => {
      logger.info('HTTP server closed');
    });
    await pool.end();
    logger.info('PostgreSQL pool closed');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}
