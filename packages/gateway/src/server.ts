import { Client } from '@elastic/elasticsearch';
import express from 'express';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { processCalendar } from './processors/calendar.js';
import { processLocation } from './processors/location.js';
import { processMessage } from './processors/message.js';
import { WebhookPayloadSchema, type ItemResult, type PushItem, type WebhookResponse } from './types/index.js';
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
        title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        start: { type: 'date' },
        end: { type: 'date' },
        location: { type: 'text' },
        source: { type: 'keyword' },
        all_day: { type: 'boolean' },
        timestamp: { type: 'date' },
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
): Promise<ItemResult> {
  try {
    switch (item.type) {
      case 'location':
        await processLocation(es, userId, item, config.geocodingApiKey);
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
export function createApp(config: EnvConfig): { app: express.Application; esClient: Client } {
  const app = express();

  // Parse JSON bodies
  app.use(express.json({ limit: '1mb' }));

  // Create ES client
  const esClient = new Client({
    node: config.elasticsearchUrl,
  });

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

    // Validate token
    const userId = config.webhookTokens[token];
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

    // Process items — each item is independent, partial failures allowed
    const results: ItemResult[] = [];

    for (let i = 0; i < payload.items.length; i++) {
      const result = await processItem(esClient, userId, payload.items[i], i, config);
      results.push(result);
    }

    const accepted = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'error').length;

    // Count by type for logging
    const typeCounts: Record<string, number> = {};
    for (const item of payload.items) {
      typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
    }

    logger.info('Webhook processed', {
      userId,
      total: payload.items.length,
      accepted,
      failed,
      types: typeCounts,
    });

    const response: WebhookResponse = { accepted, failed, results };

    if (failed > 0) {
      // Partial failure — still 200 but include failure details
      res.status(200).json(response);
    } else {
      res.status(200).json(response);
    }
  });

  return { app, esClient };
}

/**
 * Start the gateway server.
 */
export async function startServer(config: EnvConfig): Promise<void> {
  const { app, esClient } = createApp(config);

  // Ensure awareness indices exist
  logger.info('Ensuring Elasticsearch indices...');
  await ensureIndices(esClient);
  logger.info('Elasticsearch indices ready');

  app.listen(config.port, () => {
    logger.info(`Gateway listening on port ${config.port}`, {
      env: config.nodeEnv,
      tokenCount: Object.keys(config.webhookTokens).length,
    });
  });
}
