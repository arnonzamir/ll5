import { Client } from '@elastic/elasticsearch';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ZodError } from 'zod';
import { initAppLog, appLog } from '@ll5/shared';
import { createAuthRouter } from './auth.js';
import { createChatRouter } from './chat.js';
import { processCalendar } from './processors/calendar.js';
import { processLocation } from './processors/location.js';
import { processMessage } from './processors/message.js';
import { startSchedulers } from './scheduler/index.js';
import { WebhookPayloadSchema, PushItemSchema, type ItemResult, type PushItem, type WebhookResponse } from './types/index.js';
import type { EnvConfig } from './utils/env.js';
import { logger } from './utils/logger.js';

// --- Elasticsearch index definitions for awareness domain ---

const MULTILINGUAL_SETTINGS = {
  analysis: {
    analyzer: {
      multilingual: {
        type: 'custom' as const,
        tokenizer: 'standard',
        filter: ['lowercase', 'asciifolding'],
      },
    },
  },
};

const INDEX_SETTINGS = {
  number_of_shards: 1,
  number_of_replicas: 1,
  ...MULTILINGUAL_SETTINGS,
};

interface IndexDefinition {
  index: string;
  mappings: Record<string, unknown>;
}

const AWARENESS_INDICES: IndexDefinition[] = [
  {
    index: 'll5_awareness_locations',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        location: { type: 'geo_point' },
        accuracy: { type: 'float' },
        speed: { type: 'float' },
        address: { type: 'text' },
        matched_place_id: { type: 'keyword' },
        matched_place: { type: 'keyword' },
        battery_pct: { type: 'float' },
        device_timezone: { type: 'keyword' },
        timestamp: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_awareness_messages',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        sender: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        app: { type: 'keyword' },
        content: { type: 'text', analyzer: 'multilingual' },
        is_group: { type: 'boolean' },
        group_name: { type: 'keyword' },
        processed: { type: 'boolean' },
        timestamp: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_awareness_entity_statuses',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        entity_name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        summary: { type: 'text' },
        location: { type: 'text' },
        activity: { type: 'text' },
        source: { type: 'keyword' },
        timestamp: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_awareness_calendar_events',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        title: { type: 'text', analyzer: 'multilingual', fields: { keyword: { type: 'keyword' } } },
        description: { type: 'text', analyzer: 'multilingual' },
        start_time: { type: 'date' },
        end_time: { type: 'date' },
        location: { type: 'text' },
        calendar_name: { type: 'keyword' },
        calendar_id: { type: 'keyword' },
        calendar_color: { type: 'keyword' },
        google_event_id: { type: 'keyword' },
        html_link: { type: 'keyword' },
        source: { type: 'keyword' },
        status: { type: 'keyword' },
        all_day: { type: 'boolean' },
        recurring: { type: 'boolean' },
        is_free_busy: { type: 'boolean' },
        is_tickler: { type: 'boolean' },
        attendees: { type: 'keyword' },
        attendees_detail: { type: 'object', enabled: false },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_app_log',
    mappings: {
      properties: {
        timestamp: { type: 'date' },
        service: { type: 'keyword' },
        level: { type: 'keyword' },
        action: { type: 'keyword' },
        message: { type: 'text' },
        user_id: { type: 'keyword' },
        tool_name: { type: 'keyword' },
        duration_ms: { type: 'integer' },
        success: { type: 'boolean' },
        error_message: { type: 'text' },
        metadata: { type: 'object', enabled: false },
      },
    },
  },
  {
    index: 'll5_audit_log',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        timestamp: { type: 'date' },
        source: { type: 'keyword' },
        action: { type: 'keyword' },
        entity_type: { type: 'keyword' },
        entity_id: { type: 'keyword' },
        summary: { type: 'text', analyzer: 'multilingual' },
        metadata: { type: 'object', enabled: false },
      },
    },
  },
  {
    index: 'll5_awareness_notable_events',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        event_type: { type: 'keyword' },
        place_id: { type: 'keyword' },
        place_name: { type: 'keyword' },
        location: { type: 'geo_point' },
        details: { type: 'object', enabled: false },
        timestamp: { type: 'date' },
      },
    },
  },
];

/**
 * Ensure all awareness indices exist in Elasticsearch.
 * Same pattern as personal-knowledge/src/setup/indices.ts.
 */
async function ensureIndices(client: Client): Promise<void> {
  for (const def of AWARENESS_INDICES) {
    const exists = await client.indices.exists({ index: def.index });
    if (!exists) {
      logger.info(`Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: INDEX_SETTINGS,
        mappings: def.mappings,
      });
      logger.info(`Index created: ${def.index}`);
    } else {
      logger.debug(`Index already exists: ${def.index}`);
    }
  }
}

/**
 * Process a single push item. Returns result indicating success or failure.
 */
async function processItem(
  es: Client,
  userId: string,
  item: PushItem,
  itemIndex: number,
  config: EnvConfig,
  pgPool?: pg.Pool,
): Promise<ItemResult> {
  try {
    switch (item.type) {
      case 'location':
        await processLocation(es, userId, item, config.geocodingApiKey, pgPool);
        break;
      case 'message':
        await processMessage(es, userId, item);
        break;
      case 'calendar_event':
        await processCalendar(es, userId, item);
        break;
    }
    return { index: itemIndex, type: item.type, status: 'ok' };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Failed to process item', {
      index: itemIndex,
      type: item.type,
      error: errorMessage,
    });
    return { index: itemIndex, type: item.type, status: 'error', error: errorMessage };
  }
}

/**
 * Create and configure the Express application.
 */
export function createApp(config: EnvConfig): { app: express.Application; esClient: Client; pgPool: pg.Pool } {
  const app = express();

  // Parse JSON bodies
  app.use(express.json({ limit: '1mb' }));

  // Create ES client
  const esClient = new Client({
    node: config.elasticsearchUrl,
  });

  // Create PG pool for auth
  const pgPool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
  });

  // Serve static files (chat UI)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(__dirname, 'public')));

  // Mount auth routes
  app.use('/auth', createAuthRouter(pgPool, config.authSecret));

  // Mount chat routes
  app.use('/chat', createChatRouter(pgPool, config.authSecret));

  // --- Health endpoint ---
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await esClient.ping();
      res.json({ status: 'ok' });
    } catch (err) {
      logger.error('Health check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({
        status: 'error',
        message: 'Elasticsearch unavailable',
      });
    }
  });

  // --- Webhook endpoint ---
  app.post('/webhook/:token', async (req: Request, res: Response) => {
    const token = req.params.token as string;

    // Validate token: try webhook token first, then auth token, then Bearer header
    let userId = config.webhookTokens[token];

    if (!userId && config.authSecret) {
      // Try as ll5 auth token (from Android app)
      try {
        const crypto = await import('node:crypto');
        const parts = token.split('.');
        if (parts.length === 3 && parts[0] === 'll5') {
          const [, payloadB64, signature] = parts;
          const expected = crypto.createHmac('sha256', config.authSecret)
            .update(payloadB64).digest('hex').slice(0, 32);
          if (signature.length === 32 && crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')
          )) {
            const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
            if (payload.exp > Date.now() / 1000) {
              userId = payload.uid;
            }
          }
        }
      } catch { /* not a valid auth token */ }
    }

    if (!userId) {
      // Try Bearer header as last resort
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ll5.') && config.authSecret) {
        try {
          const crypto = await import('node:crypto');
          const authToken = authHeader.slice(7);
          const parts = authToken.split('.');
          if (parts.length === 3) {
            const [, payloadB64, signature] = parts;
            const expected = crypto.createHmac('sha256', config.authSecret)
              .update(payloadB64).digest('hex').slice(0, 32);
            if (signature.length === 32 && crypto.timingSafeEqual(
              Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')
            )) {
              const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
              if (payload.exp > Date.now() / 1000) {
                userId = payload.uid;
              }
            }
          }
        } catch { /* not valid */ }
      }
    }

    if (!userId) {
      res.status(401).json({ error: 'Invalid webhook token' });
      return;
    }

    // Validate payload
    let payload;
    try {
      payload = WebhookPayloadSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'Invalid payload',
          details: err.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }
      throw err;
    }

    // Validate and process items individually — bad items are skipped, not fatal
    const results: ItemResult[] = [];
    const typeCounts: Record<string, number> = {};

    for (let i = 0; i < payload.items.length; i++) {
      const parsed = PushItemSchema.safeParse(payload.items[i]);
      if (!parsed.success) {
        const errors = parsed.error.errors.map((e: { path: (string | number)[]; message: string }) => `${e.path.join('.')}: ${e.message}`).join('; ');
        logger.warn('Skipping invalid webhook item', { index: i, errors });
        results.push({ index: i, type: (payload.items[i] as Record<string, unknown>)?.type as string ?? 'unknown', status: 'error', error: errors });
        continue;
      }
      const item = parsed.data;
      typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
      const result = await processItem(esClient, userId, item, i, config, pgPool);
      results.push(result);
    }

    const accepted = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'error').length;

    logger.info('Webhook processed', {
      userId,
      total: payload.items.length,
      accepted,
      failed,
      types: typeCounts,
    });

    appLog.info('webhook', `Processed ${payload.items.length} items`, {
      user_id: userId,
      metadata: { accepted, failed, types: typeCounts },
    });

    const response: WebhookResponse = { accepted, failed, results };

    if (failed > 0) {
      // Partial failure — still 200 but include failure details
      res.status(200).json(response);
    } else {
      res.status(200).json(response);
    }
  });

  return { app, esClient, pgPool };
}

/**
 * Start the gateway server.
 */
/**
 * Run SQL migration files from the migrations directory.
 */
async function runMigrations(pool: pg.Pool): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');

  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    logger.warn('No migrations directory found', { path: migrationsDir });
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info(`Running migration: ${file}`);
    await pool.query(sql);
  }
}

export async function startServer(config: EnvConfig): Promise<void> {
  initAppLog({
    elasticsearchUrl: config.elasticsearchUrl,
    service: 'gateway',
    level: (config.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  });

  const { app, esClient, pgPool } = createApp(config);

  // Run database migrations
  logger.info('Running database migrations...');
  await runMigrations(pgPool);
  logger.info('Database migrations complete');

  // Ensure awareness indices exist
  logger.info('Ensuring Elasticsearch indices...');
  await ensureIndices(esClient);
  logger.info('Elasticsearch indices ready');

  // Start calendar sync and review schedulers
  startSchedulers(config, esClient, pgPool);

  app.listen(config.port, () => {
    logger.info(`Gateway listening on port ${config.port}`, {
      env: config.nodeEnv,
      tokenCount: Object.keys(config.webhookTokens).length,
    });
  });
}
