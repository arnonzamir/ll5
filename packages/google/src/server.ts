import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import { Client as ESClient } from '@elastic/elasticsearch';
import { google } from 'googleapis';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEnv } from './utils/env.js';
import { logger, setLogLevel } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { runMigrations } from './utils/migration-runner.js';
import { initAudit, initAppLog, withToolLogging } from '@ll5/shared';
import { PostgresOAuthTokenRepository } from './repositories/postgres/oauth-token.repository.js';
import { PostgresCalendarConfigRepository } from './repositories/postgres/calendar-config.repository.js';
import { PostgresUserSettingsRepository } from './repositories/postgres/user-settings.repository.js';
import { ESCalendarEventRepository } from './repositories/elasticsearch/calendar-event.repository.js';
import { registerAllTools } from './tools/index.js';
import { pendingStates } from './tools/auth.js';
import { createOAuth2Client, getAuthenticatedClient } from './utils/google-client.js';

const { Pool } = pg;

// User ID resolved per-request via auth middleware
let currentUserId: string = '';

function getUserId(): string {
  return currentUserId;
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel as LogLevel);

  const esUrl = process.env.ELASTICSEARCH_URL;
  if (esUrl) {
    initAppLog({
      elasticsearchUrl: esUrl,
      service: 'google',
      level: (env.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
    });
  }

  logger.info('[startServer] Starting Google MCP server', { port: env.port });

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

  // ---------------------------------------------------------------------------
  // Run migrations
  // ---------------------------------------------------------------------------
  await runMigrations(pool);

  // ---------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------
  const tokenRepo = new PostgresOAuthTokenRepository(pool, env.encryptionKey);
  const calendarConfigRepo = new PostgresCalendarConfigRepository(pool);
  const userSettingsRepo = new PostgresUserSettingsRepository(pool);

  // Elasticsearch client for unified calendar reads/writes
  const esClient = esUrl ? new ESClient({ node: esUrl }) : null;
  const esCalendarRepo = esClient ? new ESCalendarEventRepository(esClient) : null;

  if (esClient) {
    logger.info('[startServer] Elasticsearch connected for calendar reads/writes');
  } else {
    logger.warn('[startServer] ELASTICSEARCH_URL not set — calendar reads will fall back to live Google API');
  }

  const googleConfig = {
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: env.googleRedirectUri,
  };

  const deps = { tokenRepo, calendarConfigRepo, userSettingsRepo, esCalendarRepo, googleConfig };

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
        } catch (err) {
          logger.debug('[google][auth] Token validation failed', { error: err instanceof Error ? err.message : String(err) });
        }
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

  // Block MCP OAuth discovery — this server uses Bearer token auth, not OAuth
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'OAuth not supported. Use Bearer token auth.' });
  });
  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'OAuth not supported. Use Bearer token auth.' });
  });
  app.post('/register', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Dynamic client registration not supported.' });
  });

  // Health endpoint (no auth required)
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT 1');
      if (result.rows.length > 0) {
        res.json({ status: 'ok', service: 'll5-google' });
      } else {
        res.status(503).json({ status: 'unhealthy', service: 'll5-google' });
      }
    } catch (err) {
      logger.error('[google][health] Health check failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: 'unhealthy', service: 'll5-google' });
    }
  });

  // ---------------------------------------------------------------------------
  // OAuth callback endpoint (no auth — Google redirects here)
  // ---------------------------------------------------------------------------
  app.get('/oauth/callback', async (req: Request, res: Response) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (error) {
      res.status(400).send(`<html><body><h2>Authorization failed</h2><p>${error}</p></body></html>`);
      return;
    }

    if (!code || !state) {
      res.status(400).send('<html><body><h2>Missing code or state parameter</h2></body></html>');
      return;
    }

    // Validate CSRF state
    const pending = pendingStates.get(state);
    if (!pending) {
      res.status(400).send('<html><body><h2>Invalid or expired state token</h2><p>Please try the OAuth flow again.</p></body></html>');
      return;
    }
    pendingStates.delete(state);

    try {
      const oauth2Client = createOAuth2Client(googleConfig);
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.access_token || !tokens.refresh_token) {
        res.status(400).send('<html><body><h2>Missing tokens</h2><p>Ensure prompt=consent is set. Try again.</p></body></html>');
        return;
      }

      const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000);
      const grantedScopes = tokens.scope ? tokens.scope.split(' ') : pending.scopes;

      await tokenRepo.store(pending.userId, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type ?? 'Bearer',
        expires_at: expiresAt,
        scopes: grantedScopes,
      });

      let email = '';
      try {
        oauth2Client.setCredentials(tokens);
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        email = userInfo.data.email ?? '';
      } catch (err) {
        logger.warn('[startServer] Could not fetch user email after OAuth callback', { error: err instanceof Error ? err.message : String(err) });
      }

      logger.info('[startServer] OAuth callback successful', { userId: pending.userId, email });

      res.send(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
        <div style="text-align:center">
          <h2>Google connected!</h2>
          <p>Account: ${email || 'connected'}</p>
          <p>Scopes: ${grantedScopes.length} granted</p>
          <p style="color:#666">You can close this tab.</p>
        </div>
      </body></html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[startServer] OAuth callback token exchange failed', { error: message });
      res.status(500).send(`<html><body><h2>Token exchange failed</h2><p>${message}</p></body></html>`);
    }
  });

  // ---------------------------------------------------------------------------
  // REST API endpoints (for gateway consumption — same auth as /mcp)
  // ---------------------------------------------------------------------------

  // GET /api/events — returns calendar events across enabled calendars
  app.get('/api/events', authMiddleware, async (req: Request, res: Response) => {
    const userId = env.userId;
    const { from, to, calendar_id } = req.query as { from?: string; to?: string; calendar_id?: string };

    try {
      const auth = await getAuthenticatedClient(googleConfig, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });
      const settings = await userSettingsRepo.get(userId);

      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const todayStr = fmt.format(new Date());
      const timeMin = from ?? new Date(`${todayStr}T00:00:00`).toISOString();
      const timeMax = to ?? new Date(`${todayStr}T23:59:59`).toISOString();

      // Determine which calendars to query
      let calendarIds: string[];
      if (calendar_id) {
        calendarIds = [calendar_id];
      } else {
        calendarIds = await calendarConfigRepo.getReadableCalendarIds(userId);
        if (calendarIds.length === 0) {
          calendarIds = ['primary'];
        }
      }

      const localConfigs = await calendarConfigRepo.list(userId);
      const configMap = new Map(localConfigs.map((c) => [c.calendar_id, c]));

      const allEvents: Record<string, unknown>[] = [];

      for (const calId of calendarIds) {
        try {
          const response = await calendarApi.events.list({
            calendarId: calId,
            timeMin,
            timeMax,
            maxResults: 100,
            singleEvents: true,
            orderBy: 'startTime',
          });

          const config = configMap.get(calId);
          for (const event of response.data.items ?? []) {
            allEvents.push({
              event_id: event.id ?? '',
              calendar_id: calId,
              calendar_name: config?.calendar_name ?? calId,
              calendar_color: config?.color ?? '#4285f4',
              title: event.summary ?? '(no title)',
              start: event.start?.dateTime ?? event.start?.date ?? '',
              end: event.end?.dateTime ?? event.end?.date ?? '',
              all_day: !event.start?.dateTime,
              location: event.location ?? null,
              description: event.description ?? null,
              attendees: (event.attendees ?? []).map((a) => ({
                email: a.email ?? '',
                name: a.displayName ?? null,
                response_status: a.responseStatus ?? 'needsAction',
              })),
              html_link: event.htmlLink ?? '',
              status: event.status ?? 'confirmed',
              recurring: !!event.recurringEventId,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const responseData = (err as { response?: { status?: number; data?: unknown } }).response;
          logger.warn(`[startServer] Failed to fetch events from calendar ${calId}`, {
            error: message,
            status: responseData?.status,
            details: responseData?.data ? JSON.stringify(responseData.data) : undefined,
            timeMin,
            timeMax,
          });
        }
      }

      allEvents.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
      res.json({ events: allEvents, total: allEvents.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[startServer] GET /api/events failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // GET /api/ticklers — returns tickler calendar events
  app.get('/api/ticklers', authMiddleware, async (req: Request, res: Response) => {
    const userId = env.userId;
    const { from, to } = req.query as { from?: string; to?: string };

    try {
      // Find the tickler calendar
      const ticklerConfig = await calendarConfigRepo.getByRole(userId, 'tickler');

      if (!ticklerConfig) {
        res.json({ events: [], total: 0 });
        return;
      }

      const auth = await getAuthenticatedClient(googleConfig, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const timeMin = from ?? startOfDay.toISOString();
      const timeMax = to ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const response = await calendarApi.events.list({
        calendarId: ticklerConfig.calendar_id,
        timeMin,
        timeMax,
        maxResults: 100,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = (response.data.items ?? []).map((event) => ({
        event_id: event.id ?? '',
        title: event.summary ?? '',
        start: event.start?.dateTime ?? event.start?.date ?? '',
        end: event.end?.dateTime ?? event.end?.date ?? '',
        all_day: !event.start?.dateTime,
        description: event.description ?? null,
        status: event.status ?? 'confirmed',
      }));

      res.json({ events, total: events.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[startServer] GET /api/ticklers failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // MCP endpoint (stateless — new server+transport per request)
  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = new McpServer({
        name: 'll5-google',
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

  // ---------------------------------------------------------------------------
  // Start listening
  // Initialize audit logging (reuse esUrl from above)
  if (esUrl) {
    initAudit(esUrl);
    logger.info('[startServer] Audit logging enabled');
  }

  // ---------------------------------------------------------------------------
  const server = app.listen(env.port, () => {
    logger.info(`[startServer] Google MCP server listening on port ${env.port}`);
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
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
