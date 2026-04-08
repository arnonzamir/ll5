import { Client } from '@elastic/elasticsearch';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ZodError } from 'zod';
import { initAppLog, initAudit, appLog, logAudit } from '@ll5/shared';
import { createAdminRouter } from './admin.js';
import { createAuthRouter } from './auth.js';
import { createChatRouter, chatAuthMiddleware } from './chat.js';
import { processCalendar } from './processors/calendar.js';
import { processLocation } from './processors/location.js';
import { processMessage } from './processors/message.js';
import { NotificationRuleMatcher } from './processors/notification-rules.js';
import { processWhatsAppWebhook } from './processors/whatsapp-webhook.js';
import { startSchedulers } from './scheduler/index.js';
import { WebhookPayloadSchema, PushItemSchema, type ItemResult, type PushItem, type WebhookResponse } from './types/index.js';
import { queueDeviceCommand } from './utils/device-commands.js';
import { isSourceEnabled } from './utils/data-source-config.js';
import { resolveWhatsAppUserId } from './utils/whatsapp-user-resolver.js';
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
    index: 'll5_session_history',
    mappings: {
      properties: {
        session_id: { type: 'keyword' },
        workspace: { type: 'keyword' },
        message_count: { type: 'integer' },
        first_message: { type: 'date' },
        last_message: { type: 'date' },
        messages: { type: 'object', enabled: false },
        indexed_at: { type: 'date' },
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
      logger.info(`[ensureIndices][create] Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: INDEX_SETTINGS,
        mappings: def.mappings,
      });
      logger.info(`[ensureIndices][create] Index created: ${def.index}`);
    } else {
      logger.debug(`[ensureIndices][create] Index already exists: ${def.index}`);
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
  matcher?: NotificationRuleMatcher,
): Promise<ItemResult> {
  try {
    // Check data source toggles (user_settings.data_sources)
    const sourceMap: Record<string, string> = { location: 'gps', message: 'im_capture', calendar_event: 'calendar' };
    const sourceKey = sourceMap[item.type];
    if (sourceKey && pgPool && !await isSourceEnabled(pgPool, userId, sourceKey)) {
      return { index: itemIndex, type: item.type, status: 'ok' }; // silently skip
    }

    switch (item.type) {
      case 'location':
        await processLocation(es, userId, item, config.geocodingApiKey, pgPool);
        break;
      case 'message':
        await processMessage(es, userId, item, pgPool, matcher);
        break;
      case 'calendar_event':
        await processCalendar(es, userId, item);
        break;
      case 'device_calendar':
        // Metadata about phone's available calendars — accepted but not processed
        break;
    }
    return { index: itemIndex, type: item.type, status: 'ok' };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('[processItem][handle] Failed to process item', {
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

  // Mount admin routes
  app.use('/admin', createAdminRouter(pgPool, config.authSecret));

  // Serve uploaded files
  const uploadsDir = process.env.NODE_ENV === 'production' ? '/app/uploads' : './uploads';
  fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', express.static(uploadsDir));

  // Mount chat routes
  app.use('/chat', createChatRouter(pgPool, config.authSecret, esClient));

  // Create notification rule matcher
  const notificationMatcher = new NotificationRuleMatcher(pgPool);

  // --- Notification rules CRUD ---
  const authMw = chatAuthMiddleware(config.authSecret);

  app.get('/notification-rules', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const result = await pgPool.query(
      'SELECT * FROM notification_rules WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    res.json({ rules: result.rows });
  });

  app.post('/notification-rules', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { rule_type, match_value, priority, platform, download_images } = req.body;
    if (!rule_type || !match_value) {
      res.status(400).json({ error: 'rule_type and match_value required' });
      return;
    }

    // Conversation rules use upsert (one rule per conversation)
    if (rule_type === 'conversation' && platform) {
      const result = await pgPool.query(
        `INSERT INTO notification_rules (user_id, rule_type, match_value, priority, platform, download_images)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, platform, match_value) WHERE rule_type = 'conversation'
         DO UPDATE SET priority = EXCLUDED.priority, download_images = COALESCE(EXCLUDED.download_images, notification_rules.download_images)
         RETURNING *`,
        [userId, rule_type, match_value, priority || 'batch', platform, download_images ?? false],
      );
      res.status(201).json(result.rows[0]);
      return;
    }

    const result = await pgPool.query(
      'INSERT INTO notification_rules (user_id, rule_type, match_value, priority, platform) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [userId, rule_type, match_value, priority || 'immediate', platform || null],
    );
    res.status(201).json(result.rows[0]);
  });

  app.delete('/notification-rules/:id', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    await pgPool.query(
      'DELETE FROM notification_rules WHERE id = $1 AND user_id = $2',
      [req.params.id, userId],
    );
    res.json({ deleted: true });
  });

  // --- FCM token management ---

  app.post('/fcm/register', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { token, device_name } = req.body;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    try {
      await pgPool.query(
        `INSERT INTO fcm_tokens (user_id, token, device_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, token) DO UPDATE SET device_name = EXCLUDED.device_name, updated_at = now()`,
        [userId, token, device_name ?? null],
      );
      logger.info('[server][fcmRegister] FCM token registered', { userId, device_name });
      res.json({ registered: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][fcmRegister] Failed to register FCM token', { error: message });
      res.status(500).json({ error: message });
    }
  });

  app.delete('/fcm/unregister', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    try {
      await pgPool.query(
        'DELETE FROM fcm_tokens WHERE user_id = $1 AND token = $2',
        [userId, token],
      );
      logger.info('[server][fcmUnregister] FCM token unregistered', { userId });
      res.json({ unregistered: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][fcmUnregister] Failed to unregister FCM token', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // --- User settings (unified JSONB) ---

  app.get('/user-settings', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const result = await pgPool.query(
        'SELECT settings FROM user_settings WHERE user_id = $1',
        [userId],
      );
      res.json(result.rows[0]?.settings ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][getUserSettings] Failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  app.put('/user-settings', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const patch = req.body;

    if (!patch || typeof patch !== 'object') {
      res.status(400).json({ error: 'Body must be a JSON object with settings to merge' });
      return;
    }

    try {
      // Deep merge: read existing, merge in JS, write back
      const existing = await pgPool.query(
        'SELECT settings FROM user_settings WHERE user_id = $1',
        [userId],
      );
      const current = existing.rows[0]?.settings ?? {};

      // Merge top-level keys; for object values, merge nested keys
      const merged = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && current[key] && typeof current[key] === 'object') {
          merged[key] = { ...current[key], ...value };
        } else {
          merged[key] = value;
        }
      }

      await pgPool.query(
        `INSERT INTO user_settings (user_id, settings, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET
           settings = $2::jsonb,
           updated_at = now()`,
        [userId, JSON.stringify(merged)],
      );
      logger.info('[server][putUserSettings] Updated', { userId, keys: Object.keys(patch) });
      res.json({ updated: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][putUserSettings] Failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // --- Contact settings (unified routing/permission/media) ---

  app.get('/contact-settings', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { target_type, search, limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(limitStr || '200', 10), 500);
    const offset = parseInt(offsetStr || '0', 10);

    try {
      const conditions = ['user_id = $1'];
      const params: unknown[] = [userId];
      let idx = 2;

      if (target_type) {
        conditions.push(`target_type = $${idx++}`);
        params.push(target_type);
      }
      if (search) {
        conditions.push(`display_name ILIKE $${idx++}`);
        params.push(`%${search}%`);
      }

      const countResult = await pgPool.query(
        `SELECT COUNT(*) FROM contact_settings WHERE ${conditions.join(' AND ')}`,
        params,
      );
      const total = parseInt(countResult.rows[0].count, 10);

      params.push(limit, offset);
      const result = await pgPool.query(
        `SELECT * FROM contact_settings WHERE ${conditions.join(' AND ')}
         ORDER BY display_name ASC NULLS LAST, created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        params,
      );

      res.json({ settings: result.rows, total });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][getContactSettings] Failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  app.put('/contact-settings', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { target_type, target_id, routing, permission, download_media, display_name, platform } = req.body;

    if (!target_type || !target_id) {
      res.status(400).json({ error: 'target_type and target_id are required' });
      return;
    }

    try {
      await pgPool.query(
        `INSERT INTO contact_settings (user_id, target_type, target_id, routing, permission, download_media, display_name, platform)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET
           routing = COALESCE($4, contact_settings.routing),
           permission = COALESCE($5, contact_settings.permission),
           download_media = COALESCE($6, contact_settings.download_media),
           display_name = COALESCE($7, contact_settings.display_name),
           platform = COALESCE($8, contact_settings.platform),
           updated_at = now()`,
        [userId, target_type, target_id, routing ?? 'batch', permission ?? 'input', download_media ?? false, display_name ?? null, platform ?? null],
      );

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'update',
        entity_type: 'contact_settings',
        entity_id: `${target_type}:${target_id}`,
        summary: `Set ${target_type} ${display_name ?? target_id}: routing=${routing}, permission=${permission}, media=${download_media}`,
      });

      res.json({ updated: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][putContactSettings] Failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  app.delete('/contact-settings/:id', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const result = await pgPool.query(
        'DELETE FROM contact_settings WHERE id = $1 AND user_id = $2 RETURNING target_type, target_id',
        [req.params.id, userId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][deleteContactSettings] Failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // --- Device command queue ---

  app.post('/commands/queue', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { command_type, payload } = req.body;
    if (!command_type || typeof command_type !== 'string') {
      res.status(400).json({ error: 'command_type is required' });
      return;
    }
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'payload object is required' });
      return;
    }
    try {
      const commandId = await queueDeviceCommand(pgPool, userId, command_type, payload);
      res.status(201).json({ command_id: commandId, status: 'sent' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][queueCommand] Failed to queue command', { error: message });
      res.status(500).json({ error: message });
    }
  });

  app.get('/commands/pending', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const result = await pgPool.query(
        `SELECT id, command_type, payload, created_at FROM device_commands
         WHERE user_id = $1 AND status IN ('pending', 'sent')
         ORDER BY created_at ASC`,
        [userId],
      );
      res.json({ commands: result.rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][pendingCommands] Failed to fetch pending commands', { error: message });
      res.status(500).json({ error: message });
    }
  });

  app.post('/commands/:id/confirm', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const commandId = req.params.id;
    const { success, error, result_data } = req.body;
    if (typeof success !== 'boolean') {
      res.status(400).json({ error: 'success (boolean) is required' });
      return;
    }
    try {
      const newStatus = success ? 'confirmed' : 'failed';
      const result = await pgPool.query(
        `UPDATE device_commands
         SET status = $1, confirmed_at = now(), error = $2, result_data = $3, updated_at = now()
         WHERE id = $4 AND user_id = $5
         RETURNING id`,
        [newStatus, error ?? null, result_data ? JSON.stringify(result_data) : null, commandId, userId],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: 'Command not found' });
        return;
      }
      logger.info('[server][confirmCommand] Command confirmed', { commandId, success, error });
      res.json({ confirmed: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][confirmCommand] Failed to confirm command', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // --- Availability check via device ---
  app.post('/availability/check', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { accounts, check_emails, via_account, from, to, timeout_ms } = req.body;

    const hasLocal = Array.isArray(accounts) && accounts.length > 0;
    const hasFreeBusy = Array.isArray(check_emails) && check_emails.length > 0 && via_account;

    if (!from || !to || (!hasLocal && !hasFreeBusy)) {
      res.status(400).json({ error: 'from, to, and either accounts[] or (check_emails[] + via_account) are required' });
      return;
    }

    const maxTimeout = Math.min(timeout_ms ?? 15000, 30000);

    try {
      // Build command payload — either local CalendarProvider or Google FreeBusy via phone
      const payload: Record<string, unknown> = { from, to };
      if (hasFreeBusy) {
        payload.check_emails = check_emails;
        payload.via_account = via_account;
      } else {
        payload.accounts = accounts;
      }

      const commandId = await queueDeviceCommand(pgPool, userId, 'check_availability', payload);

      // Poll for result
      const startTime = Date.now();
      while (Date.now() - startTime < maxTimeout) {
        await new Promise((r) => setTimeout(r, 500));

        const result = await pgPool.query<{ status: string; result_data: unknown; error: string | null }>(
          `SELECT status, result_data, error FROM device_commands WHERE id = $1 AND user_id = $2`,
          [commandId, userId],
        );

        if (result.rows.length === 0) break;
        const cmd = result.rows[0];

        if (cmd.status === 'confirmed' && cmd.result_data) {
          logger.info('[server][checkAvailability] Result received from device', { commandId });
          res.json({ source: 'device', data: cmd.result_data });
          return;
        }
        if (cmd.status === 'failed') {
          logger.warn('[server][checkAvailability] Device command failed', { commandId, error: cmd.error });
          res.status(502).json({ error: cmd.error ?? 'Device command failed' });
          return;
        }
      }

      logger.warn('[server][checkAvailability] Timed out waiting for device response', { commandId, timeout: maxTimeout });
      res.status(504).json({ error: 'Device did not respond in time', command_id: commandId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][checkAvailability] Failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // --- Media API ---
  app.get('/media', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const { query, source, mime_type, media_type, since, limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(limitStr || '30', 10), 200);
      const offset = parseInt(offsetStr || '0', 10);

      const filters: Record<string, unknown>[] = [{ term: { user_id: userId } }];
      if (source) filters.push({ term: { source } });
      if (mime_type) filters.push({ prefix: { mime_type } });
      if (media_type) filters.push({ term: { media_type } });
      if (since) filters.push({ range: { created_at: { gte: since } } });

      const must: Record<string, unknown>[] = [];
      if (query) {
        must.push({ multi_match: { query, fields: ['filename', 'description'] } });
      }

      const result = await esClient.search({
        index: 'll5_media',
        query: {
          bool: {
            filter: filters,
            ...(must.length > 0 ? { must } : {}),
          },
        },
        sort: [{ created_at: { order: 'desc' } }],
        size: limit,
        from: offset,
      });

      const media = (result.hits.hits as Array<{ _id: string; _source?: Record<string, unknown> }>).map((h) => ({
        id: h._id,
        ...h._source,
      }));
      const total = typeof result.hits.total === 'object' ? result.hits.total.value : result.hits.total;
      res.json({ media, total });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][getMedia] Failed to query media', { error: message });
      res.json({ media: [], total: 0 });
    }
  });

  app.get('/media/:id/links', authMw, async (req: Request, res: Response) => {
    try {
      const mediaId = req.params.id as string;
      const result = await esClient.search({
        index: 'll5_media_links',
        query: {
          bool: {
            filter: [{ term: { media_id: mediaId } }],
          },
        },
        size: 100,
      });

      const links = (result.hits.hits as Array<{ _source?: Record<string, unknown> }>).map((h) => h._source);
      res.json({ links });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][getMediaLinks] Failed to query media links', { error: message });
      res.json({ links: [] });
    }
  });

  // --- Agent Journal API ---
  app.get('/journal', authMw, async (req: Request, res: Response) => {
    try {
      const { type, status, topic, since, limit: limitStr } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(limitStr || '50', 10), 200);
      const statusFilter = status ?? 'open';

      const filters: Record<string, unknown>[] = [];
      if (type) {
        filters.push({ term: { type } });
      }
      if (statusFilter !== 'all') {
        filters.push({ term: { status: statusFilter } });
      }
      if (since) {
        filters.push({ range: { created_at: { gte: since } } });
      }

      const must: Record<string, unknown>[] = [];
      if (topic) {
        must.push({ multi_match: { query: topic, fields: ['topic', 'content'] } });
      }

      const result = await esClient.search({
        index: 'll5_agent_journal',
        query: {
          bool: {
            ...(filters.length > 0 ? { filter: filters } : {}),
            ...(must.length > 0 ? { must } : {}),
          },
        },
        sort: [{ created_at: { order: 'desc' } }],
        size: limit,
      });

      const entries = (result.hits.hits as Array<{ _id: string; _source?: Record<string, unknown> }>).map((h) => ({
        id: h._id,
        ...h._source,
      }));
      const total = typeof result.hits.total === 'object' ? result.hits.total.value : result.hits.total;
      res.json({ entries, total });
    } catch (err) {
      // Index might not exist yet
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][getJournal] Failed to query journal', { error: message });
      res.json({ entries: [], total: 0 });
    }
  });

  app.patch('/journal/:id', authMw, async (req: Request, res: Response) => {
    try {
      const { status } = req.body;
      if (!status || !['resolved', 'open', 'consolidated'].includes(status)) {
        res.status(400).json({ error: 'status must be one of: resolved, open, consolidated' });
        return;
      }
      await esClient.update({
        index: 'll5_agent_journal',
        id: req.params.id as string,
        doc: {
          status,
          updated_at: new Date().toISOString(),
        },
      });
      res.json({ updated: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][updateJournal] Failed to update journal entry', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // --- User Model API ---
  app.get('/user-model', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const result = await esClient.search({
        index: 'll5_agent_user_model',
        query: {
          bool: {
            filter: [{ term: { user_id: userId } }],
          },
        },
        sort: [{ last_updated: { order: 'desc' } }],
        size: 20,
      });

      const sections = (result.hits.hits as Array<{ _id: string; _source?: Record<string, unknown> }>).map((h) => ({
        id: h._id,
        section: (h._source as Record<string, unknown>)?.section,
        content: (h._source as Record<string, unknown>)?.content,
        last_updated: (h._source as Record<string, unknown>)?.last_updated,
      }));
      res.json({ sections });
    } catch (err) {
      // Index might not exist yet
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('[server][getUserModel] Failed to query user model (index may not exist)', { error: message });
      res.json({ sections: [] });
    }
  });

  // --- Sessions API ---
  app.post('/sessions', authMw, async (req: Request, res: Response) => {
    try {
      const { session_id, messages, message_count, first_message, last_message, workspace } = req.body;
      if (!session_id) {
        res.status(400).json({ error: 'session_id required' });
        return;
      }
      await esClient.index({
        index: 'll5_session_history',
        id: session_id,
        document: {
          user_id: (req as any).userId,
          session_id,
          message_count: message_count ?? 0,
          first_message: first_message ?? null,
          last_message: last_message ?? null,
          messages: messages ?? [],
          workspace: workspace ?? 'll5-run',
          indexed_at: new Date().toISOString(),
        },
      });
      res.status(201).json({ indexed: true, session_id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][indexSession] Failed to index session', { error: message });
      res.status(500).json({ error: message });
    }
  });

  app.get('/sessions', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { limit: limitStr, offset: offsetStr } = req.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(limitStr || '20', 10), 100);
    const offset = parseInt(offsetStr || '0', 10);
    try {
      const result = await esClient.search({
        index: 'll5_session_history',
        query: { term: { 'user_id.keyword': userId } },
        sort: [{ last_message: { order: 'desc' } }],
        size: limit,
        from: offset,
        _source: ['session_id', 'message_count', 'first_message', 'last_message', 'workspace', 'indexed_at'],
      });
      const sessions = (result.hits.hits as Array<{ _source?: Record<string, unknown> }>).map((h) => h._source);
      const total = typeof result.hits.total === 'object' ? result.hits.total.value : result.hits.total;
      res.json({ sessions, total });
    } catch (err) {
      // Index might not exist yet
      res.json({ sessions: [], total: 0 });
    }
  });

  app.get('/sessions/:id', authMw, async (req: Request, res: Response) => {
    try {
      const result = await esClient.get({
        index: 'll5_session_history',
        id: req.params.id as string,
      });
      res.json(result._source);
    } catch (err) {
      logger.warn('[server][getSession] Session fetch failed', { id: req.params.id, error: err instanceof Error ? err.message : String(err) });
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // --- Export / Backup ---
  app.get('/export', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const { exportUserData } = await import('./utils/export.js');
      const sections = await exportUserData(esClient, pgPool, userId);

      const timestamp = new Date().toISOString().slice(0, 10);
      const filename = `ll5-export-${timestamp}.json`;

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json({
        exported_at: new Date().toISOString(),
        user_id: userId,
        sections: sections.map((s) => ({ name: s.name, count: s.data.length })),
        data: Object.fromEntries(sections.map((s) => [s.name, s.data])),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][export] Export failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // --- Health endpoint ---
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await esClient.ping();
      res.json({ status: 'ok' });
    } catch (err) {
      logger.error('[startServer][healthCheck] Health check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({
        status: 'error',
        message: 'Elasticsearch unavailable',
      });
    }
  });

  // --- WhatsApp webhook from Evolution API (internal, no auth required) ---
  app.post('/webhook/whatsapp*', async (req: Request, res: Response) => {
    try {
      const payload = req.body;

      // Resolve user from the instance name in the webhook payload
      const instanceName = payload?.instance as string | undefined;
      const fallbackUserId = Object.values(config.webhookTokens)[0];

      const userId = instanceName
        ? await resolveWhatsAppUserId(pgPool, instanceName, fallbackUserId)
        : fallbackUserId;

      if (!userId) {
        res.status(500).json({ error: 'No user configured' });
        return;
      }

      // Check if WhatsApp data source is enabled
      if (!await isSourceEnabled(pgPool, userId, 'whatsapp')) {
        res.json({ status: 'ok' }); // 200 to Evolution API, but skip processing
        return;
      }
      await processWhatsAppWebhook(esClient, pgPool, notificationMatcher, userId, payload);
      res.json({ status: 'ok' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][whatsappWebhook] Processing failed', { error: message });
      res.status(500).json({ error: message });
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
      } catch (err) {
        logger.debug('[startServer][webhook] Auth token validation failed', { error: err instanceof Error ? err.message : String(err) });
      }
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
        } catch (err) {
          logger.debug('[startServer][webhook] Bearer token validation failed', { error: err instanceof Error ? err.message : String(err) });
        }
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
        const rawType = (payload.items[i] as Record<string, unknown>)?.type;
        logger.warn('[startServer][webhook] Skipping invalid webhook item', { index: i, type: rawType, errors });
        results.push({ index: i, type: (payload.items[i] as Record<string, unknown>)?.type as string ?? 'unknown', status: 'error', error: errors });
        continue;
      }
      const item = parsed.data;
      typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
      const result = await processItem(esClient, userId, item, i, config, pgPool, notificationMatcher);
      results.push(result);
    }

    const accepted = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'error').length;

    logger.info('[startServer][webhook] Webhook processed', {
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
    logger.warn('[runMigrations][init] No migrations directory found', { path: migrationsDir });
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info(`[runMigrations][run] Running migration: ${file}`);
    await pool.query(sql);
  }
}

export async function startServer(config: EnvConfig): Promise<void> {
  initAppLog({
    elasticsearchUrl: config.elasticsearchUrl,
    service: 'gateway',
    level: (config.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  });

  initAudit(config.elasticsearchUrl);

  const { app, esClient, pgPool } = createApp(config);

  // Run database migrations
  logger.info('[startServer][init] Running database migrations...');
  await runMigrations(pgPool);
  logger.info('[startServer][init] Database migrations complete');

  // Ensure awareness indices exist
  logger.info('[startServer][init] Ensuring Elasticsearch indices...');
  await ensureIndices(esClient);
  logger.info('[startServer][init] Elasticsearch indices ready');

  // Start calendar sync and review schedulers
  await startSchedulers(config, esClient, pgPool);

  // Start escalation expiration checker (every 60 seconds)
  const { checkExpiredEscalations } = await import('./utils/escalation.js');
  setInterval(() => void checkExpiredEscalations(pgPool), 60_000);
  logger.info('[startServer][init] Escalation expiration checker started');

  app.listen(config.port, () => {
    logger.info(`[startServer][listen] Gateway listening on port ${config.port}`, {
      env: config.nodeEnv,
      tokenCount: Object.keys(config.webhookTokens).length,
    });
  });
}
