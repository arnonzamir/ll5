import { Client } from '@elastic/elasticsearch';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ZodError } from 'zod';
import {
  initAppLog,
  initAudit,
  appLog,
  logAudit,
  AWARENESS_INDICES,
  KNOWLEDGE_NETWORKS_INDEX,
  AWARENESS_INDEX_SETTINGS,
  validateLl5Token,
  runWithRequestContext,
  getRequestId,
  type IndexDefinition,
} from '@ll5/shared';
import { createAdminRouter } from './admin.js';
import { createTenantsRouter, enrichUser, deriveOnboarding, deriveChannels, deriveAgentRuntime } from './tenants.js';
import { createAuthRouter } from './auth.js';
import { createInvitesRouter } from './invites.js';
import { createChatRouter, chatAuthMiddleware } from './chat.js';
import { computeDeliveryMode } from './utils/delivery-mode.js';
import { getBridgeLiveness } from './utils/whatsapp-bridge-liveness.js';
import { createAgentRouter } from './agent.js';
import { createApprovalsRouter } from './approvals.js';
import { createVaultRouter } from './vault.js';
import { createTrayRouter } from './tray.js';
import { createTodayRouter } from './today.js';
import { createNarrativesRouter } from './narratives.js';
import { createGtdSurfacesRouter } from './gtd-surfaces.js';
import { createMapRouter } from './map.js';
import { processCalendar, phoneEventId } from './processors/calendar.js';
import { processLocation, type StoredPoint } from './processors/location.js';
import { processMessage } from './processors/message.js';
import { ContactRoutingResolver } from './processors/contact-routing.js';
import { processPhoneContacts } from './processors/phone-contacts.js';
import { processPhoneStatus } from './processors/phone-status.js';
import { processWifi } from './processors/wifi.js';
import { processWifiScan } from './processors/wifi-scan.js';
import { processCameraPhoto } from './processors/camera-photo.js';
import { processTrackedDevice } from './processors/findhub.js';
import { processDeviceActivity } from './processors/device-activity.js';
import { processBluetooth } from './processors/bluetooth.js';
import { processGeofence } from './processors/geofence.js';
import { processSleepSegment, processSleepClassify } from './processors/sleep.js';
import { processCurrentPlace } from './processors/current-place.js';
import { processConnectorEvent } from './processors/connector-event.js';
import { connectorForPackage, connectorForSmsSender } from '@ll5/shared';
import { startSchedulers } from './scheduler/index.js';
import { WebhookPayloadSchema, PushItemSchema, type ItemResult, type PushItem, type PushCalendarItem, type WebhookResponse } from './types/index.js';
import { queueDeviceCommand } from './utils/device-commands.js';
import { isSourceEnabled } from './utils/data-source-config.js';
import { createWhatsappWebhookRouter } from './whatsapp-webhook-route.js';
import { WhatsAppQueue } from './utils/whatsapp-queue.js';
import { dispatchEvolutionEvent, type DispatchDeps } from './processors/whatsapp-dispatch.js';
import { createUploadsRouter, resolveUploadsDir, createPublicUploadsRouter, resolvePublicUploadsDir } from './uploads-route.js';
import type { EnvConfig } from './utils/env.js';
import { raiseAlert, clearAlert, getFiringAlerts } from './utils/alerting.js';
import { logger } from './utils/logger.js';
import { recordWebhookFailure } from './utils/webhook-stats.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// --- Elasticsearch indices owned by the gateway (infra-level) ---
// The 7 ll5_awareness_* indices and ll5_knowledge_networks live in @ll5/shared
// so gateway and the MCPs cannot drift.

const GATEWAY_INFRA_INDICES: IndexDefinition[] = [
  {
    index: 'll5_session_history',
    mappings: {
      properties: {
        session_id: { type: 'keyword' },
        workspace: { type: 'keyword' },
        message_count: { type: 'integer' },
        first_message: { type: 'date' },
        last_message: { type: 'date' },
        // Structured transcript: store-only (display in the /sessions dashboard), NOT indexed.
        messages: { type: 'object', enabled: false },
        // Flat, analyzed concatenation of all message texts — the SEARCHABLE projection of
        // `messages`, so recall_everything (opt-in `sources:["session"]`) can match transcript
        // content without indexing the bulky structured array. Written in POST /sessions.
        transcript_text: { type: 'text', analyzer: 'multilingual' },
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
        request_id: { type: 'keyword' },
        session_id: { type: 'keyword' },
        trace_id: { type: 'keyword' },
      },
    },
  },
  {
    // Per-turn proactivity eval moments (shipped from the agent's eval recorder).
    // Lean behavior fields only — the AnomalyMonitor's agent-behavior checks read
    // this (suppress/ping decisions, self-consistency mismatch) for regime-shift.
    index: 'll5_eval_moments',
    mappings: {
      properties: {
        timestamp: { type: 'date' },
        user_id: { type: 'keyword' },
        decision: { type: 'keyword' },          // ground truth: 'ping_now' | 'ping_later' (booked a wake/tickler) | 'suppress'
        decision_claimed: { type: 'keyword' },   // what record_moment said
        deferral_ref: { type: 'keyword' },       // ISS-004: the wake/tickler id a ping_later was booked against
        decision_mismatch: { type: 'boolean' },  // claimed vs actual disagreement
        trigger_class: { type: 'keyword' },
        source: { type: 'keyword' },
        message_sent: { type: 'boolean' },
        cold_start: { type: 'boolean' },
        // Lookup-class tool calls made this turn (DECISION-020 §5). The
        // behavior.ungrounded_pings anomaly check reads ping_now + grounding_calls:0.
        grounding_calls: { type: 'integer' },
        // Loop CLOSES made this turn (DECISION-025 D5/D6). Tool-call-backed, like
        // grounding_calls: a close landing with grounding_calls:0 is the
        // ungrounded-close ("wrong_close") signal on the eval spine.
        close_count: { type: 'integer' },
        // Calendar writes ("pencils": create_tickler + create_event) made this turn
        // — the pencil-the-timeline capture reflex. anomaly-monitor watches this
        // going ~0 over an active window (the reflex went dormant).
        pencil_count: { type: 'integer' },
        session_id: { type: 'keyword' },
      },
    },
  },
  {
    // Per-turn LLM cost/usage (POST /telemetry/turn-cost). Declared so a fresh deploy
    // can't lock a field to a surprising dynamic type (ISS-006). NOTE: ensureIndices is
    // create-if-missing — an index that already exists keeps its dynamic mapping.
    index: 'll5_turn_costs',
    mappings: {
      properties: {
        timestamp: { type: 'date' },
        user_id: { type: 'keyword' },
        session_id: { type: 'keyword' },
        agent: { type: 'keyword' },
        model: { type: 'keyword' },
        input_tokens: { type: 'long' },
        output_tokens: { type: 'long' },
        cached_tokens: { type: 'long' },
        cache_write_tokens: { type: 'long' },
        cost_usd: { type: 'double' },
        is_main: { type: 'boolean' },
      },
    },
  },
  {
    index: 'll5_audit_log',
    mappings: {
      properties: {
        // kind: 'mutation' (semantic rows) | 'tool_call' (DECISION-012 ledger, stage 3)
        kind: { type: 'keyword' },
        user_id: { type: 'keyword' },
        timestamp: { type: 'date' },
        source: { type: 'keyword' },
        action: { type: 'keyword' },
        entity_type: { type: 'keyword' },
        entity_id: { type: 'keyword' },
        summary: { type: 'text', analyzer: 'multilingual' },
        metadata: { type: 'object', enabled: false },
        request_id: { type: 'keyword' },
        session_id: { type: 'keyword' },
        trace_id: { type: 'keyword' },
        // tool_call ledger fields. args/result are JSON STRINGS, stored (in _source)
        // but not indexed — keeps the full I/O without exploding the mapping.
        tool_name: { type: 'keyword' },
        args: { type: 'text', index: false },
        result: { type: 'text', index: false },
        duration_ms: { type: 'integer' },
        success: { type: 'boolean' },
        error_message: { type: 'text' },
      },
    },
  },
  {
    // Sleep API output: completed segments (kind:'segment') and instantaneous
    // classify readings (kind:'classify'), one doc per push. Written by
    // processors/sleep.ts. SUCCESS segments also emit a sleep_summary notable event.
    index: 'll5_awareness_sleep',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        kind: { type: 'keyword' }, // 'segment' | 'classify'
        start: { type: 'date' },
        end: { type: 'date' },
        timestamp: { type: 'date' },
        duration_min: { type: 'integer' },
        status: { type: 'keyword' }, // SUCCESS | MISSING_DATA | NOT_DETECTED (segment)
        confidence: { type: 'integer' }, // classify
        light: { type: 'integer' }, // classify
        motion_level: { type: 'integer' }, // classify (note: motion_level, not motion)
      },
    },
  },
  {
    // On-device Places "current place" candidate sets — pure enrichment, one doc
    // per push, no agent wake. Written by processors/current-place.ts. Candidates
    // are store-only (not indexed); we query by user_id + timestamp recency only.
    index: 'll5_awareness_current_place',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        timestamp: { type: 'date' },
        candidates: { type: 'object', enabled: false },
      },
    },
  },
];

async function ensureIndices(client: Client): Promise<void> {
  const all = [...AWARENESS_INDICES, KNOWLEDGE_NETWORKS_INDEX, ...GATEWAY_INFRA_INDICES];
  for (const def of all) {
    const exists = await client.indices.exists({ index: def.index });
    if (!exists) {
      logger.info(`[ensureIndices][create] Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: AWARENESS_INDEX_SETTINGS,
        mappings: def.mappings,
      });
      logger.info(`[ensureIndices][create] Index created: ${def.index}`);
    } else {
      // Index exists — additively apply the mapping so NEW fields (e.g. the
      // DECISION-012 correlation + tool-ledger fields) get their intended
      // keyword/text types instead of being dynamic-mapped. PUT _mapping only ADDS
      // fields; it errors on changing an existing field's type, which we never do
      // (caught + warned, never fatal).
      const props = (def.mappings as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (props) {
        try {
          await client.indices.putMapping({ index: def.index, properties: props as never });
          logger.debug(`[ensureIndices][mapping] Mapping ensured for: ${def.index}`);
        } catch (err) {
          logger.warn(`[ensureIndices][mapping] Mapping update skipped for ${def.index}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
  matcher?: ContactRoutingResolver,
  // G1/G2: the chronological predecessor within this batch for location items.
  // Mutated through `prevPointRef.current` so the caller can chain it across the
  // ordered location sub-sequence regardless of original array index.
  prevPointRef?: { current: StoredPoint | null },
): Promise<ItemResult> {
  try {
    // Check data source toggles (user_settings.data_sources)
    const sourceMap: Record<string, string> = {
      location: 'gps',
      message: 'im_capture',
      calendar_event: 'calendar',
      phone_status: 'phone_status',
      wifi: 'wifi',
      wifi_scan: 'wifi', // scans ride the same per-source toggle as connection events
      camera_photo: 'camera_photos',
      tracked_device: 'findhub',
      device_activity: 'device_activity',
      bluetooth: 'bluetooth',
      geofence_transition: 'geofence',
      sleep_segment: 'sleep',
      sleep_classify: 'sleep',
      current_place: 'current_place',
    };
    // Connector notifications are gated per connector (`connector_<id>`, the
    // key the dashboard's /settings/connectors page writes). A package that is
    // not in the catalog is dropped here: the phone should not forward it, and
    // the gateway never stores raw text from an unknown app.
    const appConnector = item.type === 'app_notification' ? connectorForPackage(item.package) : undefined;
    if (item.type === 'app_notification' && !appConnector) {
      logger.debug('[processItem][app_notification] package not in the connector catalog, dropped', { package: item.package });
      return { index: itemIndex, type: item.type, status: 'ok' };
    }
    const sourceKey = appConnector ? `connector_${appConnector.id}` : sourceMap[item.type];
    if (sourceKey && pgPool && !await isSourceEnabled(pgPool, userId, sourceKey)) {
      return { index: itemIndex, type: item.type, status: 'ok' }; // silently skip
    }

    switch (item.type) {
      case 'app_notification':
        if (appConnector && pgPool) {
          await processConnectorEvent(es, pgPool, userId, appConnector, {
            connector_id: appConnector.id,
            package: item.package,
            sender: null,
            title: item.title,
            text: item.text,
            big_text: item.big_text,
            post_time: item.post_time,
          });
        }
        break;
      case 'location': {
        const stored = await processLocation(
          es,
          userId,
          item,
          config.geocodingApiKey,
          pgPool,
          prevPointRef?.current ?? null,
        );
        // Only advance the predecessor when the point was actually stored;
        // a dropped glitch must not seed the next item's drift check.
        if (prevPointRef && stored) prevPointRef.current = stored;
        break;
      }
      case 'message': {
        await processMessage(es, userId, item, pgPool, matcher);
        // An SMS from a catalog sender (Cal / max / Isracard …) is ALSO a
        // connector event. The SMS row above is stored exactly as before; this
        // is an additional path, gated by the connector's own toggle, and its
        // failure never fails the message item.
        const smsConnector = item.app.toLowerCase() === 'sms' && !item.from_me ? connectorForSmsSender(item.sender) : undefined;
        if (smsConnector && pgPool && await isSourceEnabled(pgPool, userId, `connector_${smsConnector.id}`)) {
          try {
            await processConnectorEvent(es, pgPool, userId, smsConnector, {
              connector_id: smsConnector.id,
              package: null,
              sender: item.sender,
              title: null,
              text: item.body,
              big_text: null,
              post_time: item.timestamp,
            });
          } catch (err) {
            logger.error('[processItem][message] connector path failed for SMS', {
              connector: smsConnector.id, error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        break;
      }
      case 'calendar_event':
        await processCalendar(es, userId, item);
        break;
      case 'device_calendar':
        // Metadata about phone's available calendars — accepted but not processed
        break;
      case 'phone_contact':
        // Batched after the loop — accepted individually, processed in bulk
        break;
      case 'phone_status':
        await processPhoneStatus(es, pgPool, userId, item);
        break;
      case 'wifi':
        await processWifi(es, userId, item);
        break;
      case 'wifi_scan':
        await processWifiScan(es, userId, item);
        break;
      case 'camera_photo':
        await processCameraPhoto(es, pgPool, userId, item);
        break;
      case 'tracked_device':
        await processTrackedDevice(es, userId, item, config.geocodingApiKey);
        break;
      case 'device_activity':
        await processDeviceActivity(es, userId, item, pgPool);
        break;
      case 'bluetooth':
        await processBluetooth(es, userId, item);
        break;
      case 'geofence_transition':
        await processGeofence(es, userId, item, pgPool);
        break;
      case 'sleep_segment':
        await processSleepSegment(es, userId, item);
        break;
      case 'sleep_classify':
        await processSleepClassify(es, userId, item);
        break;
      case 'current_place':
        await processCurrentPlace(es, userId, item);
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

  // WhatsApp webhook bodies can be large even with base64:false (a full
  // CONTACTS_UPSERT/CHATS_UPSERT sync on a big account), and Evolution retries a
  // 413 serially → head-of-line block (the class DECISION-024 removes). Parse
  // this route with a higher limit BEFORE the global 1MB parser runs. express.json
  // marks the body read, so the global parser below is a no-op for this path.
  app.use('/webhook/whatsapp', express.json({ limit: '10mb' }));

  // Session-history saves (ISS-014): the agent's session-save hook has always POSTed the
  // whole session every turn, and the global 1MB cap silently 413'd it past ~250 messages
  // (curl -sf swallowed the failure; every session's doc froze at 174/241/264 messages).
  // A 9-day session measured 3.9MB. Same route-scoped pattern as the webhook above; the
  // durable fix is `mode:"append"` on the route (bounded tail per turn).
  app.use('/sessions', express.json({ limit: '10mb' }));

  // Parse JSON bodies (global default; 1MB DoS guard for everything else)
  app.use(express.json({ limit: '1mb' }));

  // Per-request correlation context (DECISION-012): every request gets a
  // request_id that logApp/logAudit auto-stamp. session_id/trace_id ride in from
  // optional X-LL5-* headers (agent propagation, stage 4). userId is resolved
  // later by per-route auth; the request_id is the gateway-side span id.
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    runWithRequestContext(
      {
        userId: '',
        sessionId: (req.headers['x-ll5-session-id'] as string) || undefined,
        traceId: (req.headers['x-ll5-trace-id'] as string) || undefined,
      },
      () => {
        const rid = getRequestId();
        if (rid) res.setHeader('X-Request-Id', rid);
        next();
      },
    );
  });

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
  app.use('/auth', createAuthRouter(pgPool, config.authSecret, config.dashboardUrl));

  // Mount admin routes
  app.use('/admin', createAdminRouter(pgPool, config.authSecret));

  // Mount invites routes (owns both /admin/invites* and public /invites/*).
  app.use(createInvitesRouter(pgPool, config.authSecret, config.dashboardUrl));

  // Mount tenant-management routes (superadmin-gated; owns /admin/tenants*).
  app.use(createTenantsRouter(pgPool, config.authSecret));

  // Serve uploaded files — auth + per-file ownership check enforced.
  // See uploads-route.ts for the filename → owner mapping.
  const uploadsDir = resolveUploadsDir();
  fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', createUploadsRouter({ authSecret: config.authSecret, uploadsDir }));

  // Public uploads — NO auth, unguessable filenames. Lets the agent share an
  // openable image link (POST /chat/upload?public=1). Mounted before any auth.
  const publicUploadsDir = resolvePublicUploadsDir();
  fs.mkdirSync(publicUploadsDir, { recursive: true });
  app.use('/public', createPublicUploadsRouter(publicUploadsDir));

  // Mount chat routes
  app.use('/chat', createChatRouter(pgPool, config.authSecret, esClient));

  // Mount agent-connection plane (self-scoped; owns /me/agent/*).
  app.use(createAgentRouter(pgPool, config.authSecret, config.encryptionKey, config.mcpBaseDomain));

  // Human-approval gate for conversation authority (permission). Phone/dashboard-only.
  app.use(createApprovalsRouter(pgPool, config.authSecret));

  // Vault plane (DECISION-022 + tenant addendum): approved-sites GET/PUT,
  // approval requests filed by the vault MCP (raiseAlert push to the user),
  // tenant mapping GET/PUT (vault_tenants), and /me/vault/* lifecycle wrappers
  // proxying the vault MCP's internal tenant routes.
  app.use(createVaultRouter(pgPool, config.authSecret, { vaultMcpUrl: config.vaultMcpUrl }));

  // "Needs You" tray (android-companion-ui Phase 1): GET /me/tray aggregates
  // open habit occurrences + pending contact/vault approvals; POST
  // /me/habits/outcome is the one-tap habit answer (vault answers live on
  // /me/vault/approve-site in the vault plane above).
  app.use(createTrayRouter(pgPool, config.authSecret));

  // Today card (android-companion-ui Phase 2): POST /today-card lets the
  // agent write today's first-person voice line + one thing (day_cards);
  // GET /me/today is the phone's single aggregation call (voice, next event
  // from ES, habit day-dots, needs-you count via the shared tray collectors,
  // quiet-since).
  app.use(createTodayRouter(pgPool, esClient, config.authSecret));

  // Read-only narratives API (web + mobile) — proxies the personal-knowledge MCP
  // (relevance-sorted list, detail+connections+timeline) + an ephemeral summarize.
  // sort=now re-ranks in the gateway (open-loop / calendar-proximity blend) for
  // the mobile Topics rail; the ES client feeds the calendar-proximity signal.
  app.use(createNarrativesRouter(pgPool, esClient, config.authSecret, config.mcpHealthUrls.knowledge));

  // Mobile GTD surfaces (Phase 4): inbox swipe-triage, shopping checklist,
  // Today's-actions pane. Shares the gtd MCP's tables with mirrored semantics.
  app.use(createGtdSurfacesRouter(pgPool, config.authSecret));

  // GET /me/map — devices + saved places + today's own trail, one call.
  app.use(createMapRouter(pgPool, esClient, config.authSecret));

  // Resolves message routing/media from contact_settings (the unified source of truth).
  const notificationMatcher = new ContactRoutingResolver(pgPool);

  const authMw = chatAuthMiddleware(config.authSecret);

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

  // --- Self-scoped onboarding status (unified onboarding wizard) ---
  //
  // Returns the CALLER's own onboarding + channel + phone + profile state.
  // Strictly self-scoped: userId comes from the auth token claim (NOT a param),
  // and every query filters user_id = <caller uid>. NOT admin-gated — any
  // authenticated user reads only their own row. Reuses the same channel/
  // onboarding derivation as /admin/tenants via enrichUser/deriveChannels.
  app.get('/me/onboarding', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const [enriched, settingsResult, fcmResult] = await Promise.all([
        enrichUser(pgPool, userId),
        pgPool.query('SELECT settings FROM user_settings WHERE user_id = $1', [userId]),
        pgPool.query<{ device_count: string }>(
          'SELECT COUNT(*) AS device_count FROM fcm_tokens WHERE user_id = $1',
          [userId],
        ),
      ]);

      const onboarding = enriched
        ? deriveOnboarding(enriched)
        : { completed: false, steps: {} };
      const channels = enriched
        ? deriveChannels(enriched)
        : { google: false, whatsapp: false, health: false };
      const agentRuntime = enriched
        ? deriveAgentRuntime(enriched)
        : { status: 'none', last_seen_at: null };

      const settings = (settingsResult.rows[0]?.settings ?? {}) as Record<string, unknown>;
      const deviceCount = Number(fcmResult.rows[0]?.device_count ?? 0);

      const profile = {
        display_name: (settings.display_name as string | undefined) ?? null,
        timezone: (settings.timezone as string | undefined) ?? null,
        work_week: (settings.work_week as object | undefined) ?? null,
        self_names: (settings.self_names as unknown[] | undefined) ?? null,
      };

      logger.debug('[server][meOnboarding] Derived self-scoped onboarding status', {
        userId,
        onboardingCompleted: onboarding.completed,
        onboardingSteps: Object.keys(onboarding.steps),
        channels,
        phoneLinked: deviceCount > 0,
        deviceCount,
        hasProfile: {
          display_name: profile.display_name !== null,
          timezone: profile.timezone !== null,
          work_week: profile.work_week !== null,
          self_names: profile.self_names !== null,
        },
      });

      res.json({
        onboarding,
        channels,
        agent_runtime: agentRuntime,
        phone: { linked: deviceCount > 0, device_count: deviceCount },
        profile,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][meOnboarding] Failed', { error: message });
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

  // --- Internal endpoints for opencode plugins (dual-run-variant Phase 2) ---
  //
  // These thin proxy/helper endpoints are called by the opencode variant's
  // plugins (session-start, compaction, activity-marker, continuity-probe,
  // memory-intercept, memory-recall). They forward to existing MCP tools or
  // aggregate data the plugins can't get via MCP directly. All are
  // chatAuthMiddleware-gated. Only exercised when OPENCODE_SERVER_URL is set
  // (opencode variant); harmless no-ops otherwise.

  const INTERNAL_MCP_TIMEOUT_MS = 8000;

  /**
   * Call an MCP tool server-side, forwarding the caller's bearer token so the
   * MCP scopes to the right user. Connects per request (cheap; mirrors the
   * narratives router + MCP health probe). Returns the parsed JSON of the
   * first text content, or null.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function callMcpTool(
    baseUrl: string,
    authHeader: string,
    tool: string,
    args: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const mcpUrl = `${baseUrl.replace(/\/$/, '')}/mcp`;
    let client: McpClient | null = null;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: authHeader } },
      });
      client = new McpClient({ name: 'll5-gateway-internal', version: '0.1.0' }, { capabilities: {} });
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`mcp_timeout_${INTERNAL_MCP_TIMEOUT_MS}ms`)), INTERNAL_MCP_TIMEOUT_MS)),
      ]);
      const res = await Promise.race([
        client.callTool({ name: tool, arguments: args }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`mcp_timeout_${INTERNAL_MCP_TIMEOUT_MS}ms`)), INTERNAL_MCP_TIMEOUT_MS)),
      ]);
      const content = res.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.find((c) => c.type === 'text')?.text;
      return text ? JSON.parse(text) : null;
    } finally {
      if (client) await client.close().catch(() => {});
    }
  }

  // POST /internal/agent-session — session registration.
  // The agent container calls this on startup after creating its opencode
  // session. The gateway stores the session ID so triggerAgent() can route
  // prompts without a static env var. Workers register with sessionType.
  app.post('/internal/agent-session', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { sessionId, sessionType = 'main' } = req.body ?? {};

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const validTypes = ['main', 'narrative-loop', 'reconcile-loop'];
    if (!validTypes.includes(sessionType)) {
      res.status(400).json({
        error: `sessionType must be one of: ${validTypes.join(', ')}`,
      });
      return;
    }

    const ts = new Date().toISOString();
    try {
      if (sessionType === 'main') {
        await pgPool.query(
          `INSERT INTO user_settings (user_id, agent_session_id, agent_sessions, agent_session_heartbeats, settings, updated_at)
           VALUES ($1, $2::text, jsonb_build_object('main', $2::text), jsonb_build_object('main', $3::text), '{}'::jsonb, now())
           ON CONFLICT (user_id) DO UPDATE SET
             agent_session_id = EXCLUDED.agent_session_id,
             agent_sessions = user_settings.agent_sessions
               || jsonb_build_object('main', EXCLUDED.agent_session_id::text),
             agent_session_heartbeats = user_settings.agent_session_heartbeats
               || jsonb_build_object('main', $3::text),
             updated_at = now()`,
          [userId, sessionId, ts],
        );
      } else {
        await pgPool.query(
          `INSERT INTO user_settings (user_id, agent_sessions, agent_session_heartbeats, settings, updated_at)
           VALUES ($1, jsonb_build_object($2::text, $4::text), jsonb_build_object($2::text, $3::text), '{}'::jsonb, now())
           ON CONFLICT (user_id) DO UPDATE SET
             agent_sessions = user_settings.agent_sessions
               || jsonb_build_object($2::text, $4::text),
             agent_session_heartbeats = user_settings.agent_session_heartbeats
               || jsonb_build_object($2::text, $3::text),
             updated_at = now()`,
          [userId, sessionType, ts, sessionId],
        );
      }

      logger.info('[server][agentSession] Registered agent session', {
        userId,
        sessionType,
        sessionId,
      });
      res.json({ ok: true, sessionType, sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][agentSession] Failed to register session', {
        error: message,
        userId,
        sessionType,
      });
      res.status(500).json({ error: message });
    }
  });

  // GET /me/agent-sessions — return session IDs + heartbeat timestamps for
  // the current user's agent workers. Used by the dashboard Workers card.
  app.get('/me/agent-sessions', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const result = await pgPool.query(
        `SELECT agent_session_id, agent_sessions, agent_session_heartbeats
         FROM user_settings WHERE user_id = $1`,
        [userId],
      );
      if (result.rows.length === 0) {
        res.json({ agent_session_id: null, agent_sessions: {}, agent_session_heartbeats: {} });
        return;
      }
      const row = result.rows[0];
      res.json({
        agent_session_id: row.agent_session_id ?? null,
        agent_sessions: row.agent_sessions ?? {},
        agent_session_heartbeats: row.agent_session_heartbeats ?? {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /internal/ingest-memory — forward intercepted write content to the
  // awareness MCP ingest_memory tool. The memory-intercept plugin can't call
  // MCP tools directly (it can only call HTTP endpoints), so it calls this.
  app.post('/internal/ingest-memory', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const auth = req.headers.authorization;
    if (!auth) { res.status(401).json({ error: 'missing authorization' }); return; }
    const { raw_content, file_path } = req.body ?? {};
    if (!raw_content || typeof raw_content !== 'string') {
      res.status(400).json({ error: 'raw_content is required' });
      return;
    }
    try {
      const out = await callMcpTool(config.mcpHealthUrls.awareness, auth, 'ingest_memory', {
        raw_content,
        file_path: typeof file_path === 'string' ? file_path : undefined,
      });
      res.json({ ok: true, result: out });
    } catch (err) {
      logger.warn('[server][ingestMemory] Failed', { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: 'ingest_memory failed' });
    }
  });

  // GET /internal/regrounding — aggregate re-grounding context for
  // session-start/compaction plugins: recent_sessions + list_narratives +
  // recall_lessons. Returns a text block the plugin injects as context.
  app.get('/internal/regrounding', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const auth = req.headers.authorization;
    if (!auth) { res.status(401).json({ error: 'missing authorization' }); return; }
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    try {
      const [sessions, narratives, lessons] = await Promise.all([
        callMcpTool(config.mcpHealthUrls.awareness, auth, 'recent_sessions', { days: 7 }).catch(() => null),
        callMcpTool(config.mcpHealthUrls.knowledge, auth, 'list_narratives', { status: 'active', limit: 20, max_chars: 100_000 }).catch(() => null), // ISS-019: regrounding wants all 20
        callMcpTool(config.mcpHealthUrls.awareness, auth, 'recall_lessons', { query }).catch(() => null),
      ]);
      res.json({ sessions, narratives, lessons });
    } catch (err) {
      logger.warn('[server][regrounding] Failed', { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: 'regrounding aggregation failed' });
    }
  });

  // POST /internal/activity — log a lightweight activity marker row to
  // chat_messages (channel='system', metadata.kind='activity'). Same as the
  // Claude Code activity-marker.sh hook does via the channel bridge.
  app.post('/internal/activity', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { text, kind = 'activity' } = req.body ?? {};
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    try {
      await pgPool.query(
        `INSERT INTO chat_messages (user_id, conversation_id, channel, direction, role, content, status, metadata)
         VALUES ($1, gen_random_uuid(), 'system', 'inbound', 'system', $2, 'delivered', $3)`,
        [userId, text.slice(0, 1000), JSON.stringify({ kind })],
      );
      res.json({ ok: true });
    } catch (err) {
      logger.warn('[server][activity] Failed', { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'activity write failed' });
    }
  });

  // POST /internal/continuity-probe — report a continuity grade to ll5_app_log.
  app.post('/internal/continuity-probe', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { grade, detail } = req.body ?? {};
    if (!grade || typeof grade !== 'string') {
      res.status(400).json({ error: 'grade is required' });
      return;
    }
    appLog.info('continuity_probe', `grade=${grade}`, {
      user_id: userId,
      metadata: { grade, detail: typeof detail === 'string' ? detail.slice(0, 500) : undefined },
    });
    res.json({ ok: true });
  });

  // POST /internal/memory-intercept-log — log an intercept attempt for
  // debugging (Phase 2.5 only; productionized memory-intercept uses
  // /internal/ingest-memory in Phase 3).
  app.post('/internal/memory-intercept-log', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { file_path, reason, matched } = req.body ?? {};
    appLog.info('memory_intercept', `intercept ${matched ? 'matched' : 'skipped'}: ${reason ?? ''}`, {
      user_id: userId,
      metadata: {
        file_path: typeof file_path === 'string' ? file_path : undefined,
        reason: typeof reason === 'string' ? reason.slice(0, 300) : undefined,
        matched: Boolean(matched),
      },
    });
    res.json({ ok: true });
  });

  // POST /internal/recall-lessons — forward a recall_lessons query to the
  // awareness MCP. The memory-recall plugin can't call MCP directly.
  app.post('/internal/recall-lessons', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const auth = req.headers.authorization;
    if (!auth) { res.status(401).json({ error: 'missing authorization' }); return; }
    const { query } = req.body ?? {};
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }
    try {
      const out = await callMcpTool(config.mcpHealthUrls.awareness, auth, 'recall_lessons', { query });
      res.json({ ok: true, result: out });
    } catch (err) {
      logger.warn('[server][recallLessons] Failed', { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: 'recall_lessons failed' });
    }
  });

  // --- Tool-result telemetry (channel MCP → app_log) ---
  // The channel MCP runs in the agent container and has no ES access, so its tool
  // calls (inspect_image, reply, push_to_user, …) never reached ll5_app_log — unlike
  // the HTTP MCPs. This endpoint lets it report each tool result so the
  // ToolFailureMonitor can see channel-tool breakages (the inspect_image blind spot).
  app.post('/telemetry/tool-result', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { tool_name, success, duration_ms, error_message, source } = req.body ?? {};
    if (!tool_name || typeof tool_name !== 'string') {
      res.status(400).json({ error: 'tool_name required' });
      return;
    }
    const ok = success !== false;
    appLog.info('tool_call', `${tool_name} ${ok ? 'ok' : 'failed'}`, {
      user_id: userId,
      tool_name,
      success: ok,
      duration_ms: typeof duration_ms === 'number' ? duration_ms : undefined,
      error_message: ok ? undefined : String(error_message ?? '').slice(0, 300),
      metadata: { source: typeof source === 'string' ? source : 'll5-channel' },
    });
    res.json({ ok: true });
  });

  // --- Proactivity eval moments (agent's eval recorder → ll5_eval_moments) ---
  // Lean per-turn behavior fields, shipped from the box-side eval recorder so the
  // AnomalyMonitor's agent-behavior checks (suppress spike / mismatch spike — the
  // regime-shift the inspect_image breakage caused) can read them from ES.
  app.post('/telemetry/eval-moment', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ts = (b.ts ?? b.timestamp) as string | undefined;
    if (!ts || typeof ts !== 'string') {
      res.status(400).json({ error: 'ts required' });
      return;
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const bool = (v: unknown) => (v == null ? undefined : Boolean(v));
    const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
    try {
      const sessionId = str(b.session_id);
      const outcome = await indexOnce('ll5_eval_moments', sessionId ? `${sessionId}:${ts}` : undefined, {
        timestamp: ts,
        user_id: userId,
        decision: str(b.decision),
        decision_claimed: str(b.decision_claimed),
        deferral_ref: str(b.deferral_ref),
        decision_mismatch: bool(b.decision_mismatch),
        trigger_class: str(b.trigger_class),
        source: str(b.source),
        message_sent: bool(b.message_sent),
        cold_start: bool(b.cold_start),
        grounding_calls: int(b.grounding_calls),
        close_count: int(b.close_count),
        pencil_count: int(b.pencil_count),
        session_id: sessionId,
      });
      res.json(outcome === 'duplicate' ? { ok: true, duplicate: true } : { ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'index failed' });
    }
  });

  // --- Per-turn LLM cost/usage (agent stop-mirror → ll5_turn_costs) ---
  // opencode reports REAL provider token counts per turn; the box-side
  // model-cost lib multiplies by the verified Zen price table. Stored in ES so
  // spend is queryable by day / model / agent (nothing else persists tokens or
  // cost — the provider's per-call cost is otherwise thrown away).
  app.post('/telemetry/turn-cost', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ts = (b.ts ?? b.timestamp) as string | undefined;
    if (!ts || typeof ts !== 'string') {
      res.status(400).json({ error: 'ts required' });
      return;
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const bool = (v: unknown) => (v == null ? undefined : Boolean(v));
    try {
      const sessionId = str(b.session_id);
      const outcome = await indexOnce('ll5_turn_costs', sessionId ? `${sessionId}:${ts}` : undefined, {
        timestamp: ts,
        user_id: userId,
        session_id: sessionId,
        agent: str(b.agent),
        model: str(b.model),
        input_tokens: num(b.input_tokens),
        output_tokens: num(b.output_tokens),
        cached_tokens: num(b.cached_tokens),
        cache_write_tokens: num(b.cache_write_tokens),
        cost_usd: num(b.cost_usd),
        is_main: bool(b.is_main),
      });
      res.json(outcome === 'duplicate' ? { ok: true, duplicate: true } : { ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'index failed' });
    }
  });

  /** HTTP status off an @elastic/elasticsearch ResponseError (or anything shaped like one). */
  function esStatus(err: unknown): number | undefined {
    return (err as { meta?: { statusCode?: number } })?.meta?.statusCode
      ?? (err as { statusCode?: number })?.statusCode;
  }

  /**
   * Idempotent telemetry write (ISS-005). With a deterministic id + op_type:create, a
   * retried / double-fired Stop hook lands as a 409 instead of a second doc — so it can't
   * double-count into the anomaly monitor's rate-shift baselines. Without an id (no
   * session_id in the body) it degrades to the old auto-id append. Hoisted; used by the
   * two /telemetry routes above.
   */
  async function indexOnce(
    index: string,
    id: string | undefined,
    document: Record<string, unknown>,
  ): Promise<'created' | 'duplicate'> {
    if (!id) {
      await esClient.index({ index, document });
      return 'created';
    }
    try {
      await esClient.index({ index, id, op_type: 'create', document });
      return 'created';
    } catch (err) {
      if (esStatus(err) === 409) return 'duplicate';
      throw err;
    }
  }

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
      // For an INSERT (new row) we need sensible defaults; for an UPDATE we must
      // leave omitted fields UNCHANGED. COALESCE($n, existing) only preserves
      // the existing value when the bound param is NULL — so omitted fields are
      // bound NULL, and the INSERT defaults are applied via the table DEFAULT /
      // an explicit COALESCE on the insert side.
      const insertRouting = routing ?? 'batch';
      const insertPermission = permission ?? 'input';
      const insertDownloadMedia = download_media ?? false;
      await pgPool.query(
        `INSERT INTO contact_settings (user_id, target_type, target_id, routing, permission, download_media, display_name, platform)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET
           routing = COALESCE($9, contact_settings.routing),
           permission = COALESCE($10, contact_settings.permission),
           download_media = COALESCE($11, contact_settings.download_media),
           display_name = COALESCE($7, contact_settings.display_name),
           platform = COALESCE($8, contact_settings.platform),
           updated_at = now()`,
        [
          userId, target_type, target_id,
          insertRouting, insertPermission, insertDownloadMedia,
          display_name ?? null, platform ?? null,
          // Update-only binds: NULL when omitted so COALESCE keeps the existing value.
          routing ?? null, permission ?? null, download_media ?? null,
        ],
      );
      logger.info('[server][putContactSettings] Contact settings upserted', {
        userId, target_type, target_id,
        routing_changed: routing !== undefined,
        permission_changed: permission !== undefined,
        download_media_changed: download_media !== undefined,
      });

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

      // Abort the poll loop if the client disconnects, so we stop holding a
      // pool connection (and stop querying) for a request nobody is waiting on.
      let aborted = false;
      req.on('close', () => {
        aborted = true;
        logger.info('[server][checkAvailability] Client disconnected, aborting poll', { commandId });
      });

      // Poll for result
      const startTime = Date.now();
      while (Date.now() - startTime < maxTimeout) {
        if (aborted) return;
        await new Promise((r) => setTimeout(r, 500));
        if (aborted) return;

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
    const userId = (req as any).userId;
    try {
      const mediaId = req.params.id as string;
      const result = await esClient.search({
        index: 'll5_media_links',
        query: {
          bool: {
            filter: [{ term: { media_id: mediaId } }, { term: { user_id: userId } }],
          },
        },
        size: 100,
      });

      const links = (result.hits.hits as Array<{ _source?: Record<string, unknown> }>).map((h) => h._source);
      logger.debug('[server][getMediaLinks] Media links fetched', { mediaId, count: links.length });
      res.json({ links });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][getMediaLinks] Failed to query media links', { error: message });
      res.json({ links: [] });
    }
  });

  // --- Agent Journal API ---
  app.get('/journal', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const { type, status, topic, since, limit: limitStr } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(limitStr || '50', 10), 200);
      const statusFilter = status ?? 'open';

      const filters: Record<string, unknown>[] = [{ term: { user_id: userId } }];
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
    const userId = (req as any).userId;
    const entryId = req.params.id as string;
    try {
      const { status } = req.body;
      if (!status || !['resolved', 'open', 'consolidated'].includes(status)) {
        res.status(400).json({ error: 'status must be one of: resolved, open, consolidated' });
        return;
      }

      // Ownership check: fetch the entry and confirm it belongs to the caller.
      // On a miss return 404 (not 403) so we never disclose existence.
      let ownerUserId: string | undefined;
      try {
        const existing = await esClient.get<{ user_id?: string }>({ index: 'll5_agent_journal', id: entryId });
        ownerUserId = existing._source?.user_id;
      } catch {
        ownerUserId = undefined;
      }
      if (ownerUserId !== userId) {
        logger.warn('[server][updateJournal] cross_user_access_denied', {
          actor_user_id: userId,
          owner_user_id: ownerUserId ?? null,
          resource: 'agent_journal',
          id: entryId,
        });
        res.status(404).json({ error: 'Not found' });
        return;
      }

      await esClient.update({
        index: 'll5_agent_journal',
        id: entryId,
        doc: {
          status,
          updated_at: new Date().toISOString(),
        },
      });
      logger.info('[server][updateJournal] Journal entry updated', { id: entryId, status });
      res.json({ updated: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][updateJournal] Failed to update journal entry', { error: message });
      res.status(500).json({ error: message });
    }
  });

  // --- User Model API ---
  // DECISION-030: the user's current delivery mode (sleep / quiet_hours / driving /
  // meeting / sick / normal). The channel MCP stamps it on every inbound envelope;
  // the apps can show it. Cached 60s per user inside computeDeliveryMode.
  // ISS-013/031: what the Evolution → gateway bridge last delivered (any event),
  // the ground truth the WhatsApp flow and inbound-volume checks now consult.
  app.get('/me/bridge-liveness', authMw, (req: Request, res: Response) => {
    const userId = (req as any).userId;
    res.json(getBridgeLiveness(userId) ?? { last_event_at: null, last_event: null, last_message_event_at: null, connection_state: null, connection_state_at: null });
  });

  app.get('/me/delivery-mode', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      res.json(await computeDeliveryMode(pgPool, esClient, userId, config.calendarReviewTimezone));
    } catch (err) {
      logger.error('[deliveryMode][get] failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'delivery mode unavailable' });
    }
  });

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
  // Two write modes (ISS-014):
  //  - replace (default — what session-save.sh has always sent): full overwrite keyed on
  //    session_id.
  //  - append: the caller sends only the TAIL of the transcript; we keep what is stored
  //    and add the messages whose timestamp is newer than the stored last_message.
  //    Bounded payload every turn, idempotent on retry (older/duplicate messages are
  //    filtered by timestamp), optimistic concurrency on the doc (if_seq_no).
  // Both keep at most MAX_STORED_MESSAGES (oldest dropped — the PreCompact transcript
  // backup holds the rest, and `messages_dropped` records the count) and project the
  // searchable transcript_text from the NEWEST 200k chars — it used to be the OLDEST
  // 200k, so a long session's recent turns were never searchable.
  const MAX_STORED_MESSAGES = 5000;
  const TRANSCRIPT_TEXT_CHARS = 200_000;
  type SessionMsg = { role?: unknown; text?: unknown; timestamp?: unknown };
  const projectTranscript = (msgs: SessionMsg[]): string =>
    msgs
      .map((m) => (typeof m?.text === 'string' ? m.text : ''))
      .filter(Boolean)
      .join('\n')
      .slice(-TRANSCRIPT_TEXT_CHARS);
  const isoStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

  app.post('/sessions', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const { session_id, messages, message_count, first_message, last_message, workspace, mode } = (req.body ?? {}) as Record<string, unknown>;
      if (!session_id || typeof session_id !== 'string') {
        res.status(400).json({ error: 'session_id required' });
        return;
      }
      const incoming: SessionMsg[] = Array.isArray(messages) ? (messages as SessionMsg[]) : [];
      const now = new Date().toISOString();

      if (mode === 'append') {
        let existing: Record<string, unknown> | undefined;
        let seqNo: number | undefined;
        let primaryTerm: number | undefined;
        try {
          const got = await esClient.get<Record<string, unknown>>({ index: 'll5_session_history', id: session_id });
          existing = got._source;
          seqNo = got._seq_no;
          primaryTerm = got._primary_term;
        } catch (err) {
          if (esStatus(err) !== 404) throw err;
        }
        if (existing && existing.user_id !== userId) {
          res.status(403).json({ error: 'session belongs to another user' });
          return;
        }
        const stored = Array.isArray(existing?.messages) ? (existing!.messages as SessionMsg[]) : [];
        const storedLast = isoStr(existing?.last_message) ?? '';
        // ISO-8601 Z timestamps from one transcript compare correctly as strings.
        const fresh = incoming.filter((m) => typeof m?.timestamp === 'string' && m.timestamp > storedLast);
        const combined = [...stored, ...fresh];
        const dropped = Math.max(0, combined.length - MAX_STORED_MESSAGES);
        const kept = dropped ? combined.slice(dropped) : combined;
        const priorCount = typeof existing?.message_count === 'number' ? existing.message_count : stored.length;
        const priorDropped = typeof existing?.messages_dropped === 'number' ? existing.messages_dropped : 0;
        const newLast = fresh.length ? (fresh[fresh.length - 1].timestamp as string) : (storedLast || null);
        await esClient.index({
          index: 'll5_session_history',
          id: session_id,
          ...(seqNo != null && primaryTerm != null ? { if_seq_no: seqNo, if_primary_term: primaryTerm } : {}),
          document: {
            user_id: userId,
            session_id,
            message_count: typeof message_count === 'number' ? message_count : priorCount + fresh.length,
            first_message: isoStr(existing?.first_message) ?? isoStr(first_message) ?? isoStr(kept[0]?.timestamp),
            last_message: isoStr(last_message) ?? newLast,
            messages: kept,
            messages_dropped: priorDropped + dropped,
            transcript_text: projectTranscript(kept),
            workspace: workspace ?? existing?.workspace ?? 'll5-run',
            indexed_at: now,
          },
        });
        res.status(201).json({ indexed: true, session_id, mode: 'append', appended: fresh.length, stored: kept.length, dropped });
        return;
      }

      // replace (default)
      const dropped = Math.max(0, incoming.length - MAX_STORED_MESSAGES);
      const kept = dropped ? incoming.slice(dropped) : incoming;
      await esClient.index({
        index: 'll5_session_history',
        id: session_id,
        document: {
          user_id: userId,
          session_id,
          message_count: typeof message_count === 'number' ? message_count : incoming.length,
          first_message: isoStr(first_message),
          last_message: isoStr(last_message),
          messages: kept,
          messages_dropped: dropped,
          transcript_text: projectTranscript(kept),
          workspace: workspace ?? 'll5-run',
          indexed_at: now,
        },
      });
      res.status(201).json({ indexed: true, session_id, mode: 'replace', stored: kept.length, dropped });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (esStatus(err) === 409) {
        // Lost an optimistic-concurrency race with a concurrent save; the next turn's
        // append re-sends the tail, so this is safe to surface as a retryable conflict.
        res.status(409).json({ error: 'concurrent session write — retry', session_id: (req.body ?? {}).session_id });
        return;
      }
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

  // Active system-health alerts for the user (drives the web + Android banners).
  app.get('/alerts', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const alerts = await getFiringAlerts(pgPool, userId);
      res.json({ alerts });
    } catch (err) {
      logger.error('[GET /alerts] failed', { error: err instanceof Error ? err.message : String(err) });
      res.json({ alerts: [] });
    }
  });

  // Raise (or resolve) a system alert (used by external watchdog for agent
  // liveness, and by the agent's MCP-connectivity probe). Pass `resolved: true`
  // with just a `key` to clear a previously-raised alert on recovery — this lets
  // on-demand probes raise-on-failure + clear-on-recovery idempotently by key.
  app.post('/alerts', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { key, severity, summary, value, expected, suggestion } = body as Record<string, string | undefined>;
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    if (body.resolved === true) {
      try {
        await clearAlert(pgPool, userId, key);
        res.json({ ok: true, cleared: true });
      } catch (err) {
        logger.error('[POST /alerts] clear failed', { key, error: err instanceof Error ? err.message : String(err) });
        res.status(500).json({ error: 'Failed to clear alert' });
      }
      return;
    }
    if (!severity || !summary) {
      res.status(400).json({ error: 'severity and summary are required (or pass resolved:true with key)' });
      return;
    }
    if (severity !== 'warning' && severity !== 'critical') {
      res.status(400).json({ error: 'severity must be "warning" or "critical"' });
      return;
    }
    try {
      await raiseAlert(pgPool, { userId, key, severity, summary, value, expected, suggestion });
      res.json({ ok: true });
    } catch (err) {
      logger.error('[POST /alerts] failed', { key, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to raise alert' });
    }
  });

  // --- Geofences (Android geofence registration) ---
  //
  // Returns the caller's known places as geofence definitions for the phone's
  // Play-Services geofencing client to register. Built from ll5_knowledge_places:
  // place_id = the ES _id, lat/lon from the `geo` geo_point, radius_m from the doc
  // (null allowed → the app applies its own default). Places without coordinates
  // are FILTERED OUT — the app's parser rejects null lat/lon, and a geofence needs
  // a center. On these clean DWELL transitions the gateway records authoritative
  // arrivals (see processors/geofence.ts), so we no longer rely on GPS motion-gate
  // reconstruction for arrivals.
  app.get('/geofences', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    try {
      const result = await esClient.search({
        index: 'll5_knowledge_places',
        query: { bool: { filter: [{ term: { user_id: userId } }] } },
        size: 1000,
        _source: ['name', 'geo', 'radius_m'],
      });

      const geofences = (result.hits.hits as Array<{
        _id: string;
        _source?: { name?: string; geo?: { lat?: number; lon?: number }; radius_m?: number | null };
      }>)
        .map((h) => {
          const src = h._source ?? {};
          const lat = src.geo?.lat;
          const lon = src.geo?.lon;
          // Filter out places with no coordinates — the app rejects null lat/lon.
          if (typeof lat !== 'number' || typeof lon !== 'number') return null;
          return {
            place_id: h._id,
            name: src.name ?? '',
            lat,
            lon,
            radius_m: typeof src.radius_m === 'number' ? src.radius_m : null,
          };
        })
        .filter((g): g is { place_id: string; name: string; lat: number; lon: number; radius_m: number | null } => g !== null);

      res.json(geofences);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][getGeofences] Failed to query geofences', { error: message });
      // Index might not exist yet — return an empty array, never 500.
      res.json([]);
    }
  });

  app.get('/sessions/:id', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const sessionId = req.params.id as string;
    try {
      const result = await esClient.get<{ user_id?: string }>({
        index: 'll5_session_history',
        id: sessionId,
      });
      const ownerUserId = result._source?.user_id;
      if (ownerUserId !== userId) {
        // Cross-user/ownership miss → 404 (not 403) to avoid existence disclosure.
        logger.warn('[server][getSession] cross_user_access_denied', {
          actor_user_id: userId,
          owner_user_id: ownerUserId ?? null,
          resource: 'session_history',
          id: sessionId,
        });
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      logger.debug('[server][getSession] Session fetched', { id: sessionId });
      res.json(result._source);
    } catch (err) {
      logger.warn('[server][getSession] Session fetch failed', { id: sessionId, error: err instanceof Error ? err.message : String(err) });
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // --- Tool-call ledger (DECISION-012) — the eval-replay cassette source. ---
  // Returns kind:'tool_call' audit rows (full args/result) for the caller, filtered
  // by session/trace/tool/time. The eval cassette = query this by a moment's
  // session_id + time window (or trace_id).
  app.get('/audit/tool-calls', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { session_id, trace_id, tool_name, from, to, limit: limitStr } = req.query as Record<string, string>;
    const limit = Math.min(parseInt(limitStr || '200', 10), 1000);
    const filter: Array<Record<string, unknown>> = [
      { term: { user_id: userId } },
      { term: { kind: 'tool_call' } },
    ];
    if (session_id) filter.push({ term: { session_id } });
    if (trace_id) filter.push({ term: { trace_id } });
    if (tool_name) filter.push({ term: { tool_name } });
    if (from || to) {
      filter.push({ range: { timestamp: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } });
    }
    try {
      const result = await esClient.search({
        index: 'll5_audit_log',
        query: { bool: { filter } },
        sort: [{ timestamp: { order: 'asc' } }],
        size: limit,
      });
      const calls = (result.hits.hits as Array<{ _source?: Record<string, unknown> }>).map((h) => h._source);
      const total = typeof result.hits.total === 'object' ? result.hits.total.value : result.hits.total;
      res.json({ calls, total });
    } catch (err) {
      // Index might not exist yet, or no rows — return empty, never 500.
      logger.debug('[server][toolCalls] query failed (treating as empty)', { error: err instanceof Error ? err.message : String(err) });
      res.json({ calls: [], total: 0 });
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

  // --- WhatsApp webhook from Evolution API ---
  // Authenticated via shared X-Webhook-Secret header (see whatsapp-webhook-route.ts).
  // Mounted at both /webhook/whatsapp and /webhook/whatsapp/* so existing Evolution
  // API configs with sub-paths continue to work.
  // WhatsApp ingest queue (DECISION-024): Evolution fast-acks into RabbitMQ and
  // a worker dispatches at its own pace. Falls back to inline processing when
  // the broker is absent/down, so it is never a hard dependency.
  const whatsappDispatchDeps: DispatchDeps = {
    pgPool,
    esClient,
    notificationMatcher,
    encryptionKey: config.encryptionKey,
    evolutionApiUrl: config.evolutionApiUrl,
    evolutionApiKey: config.evolutionApiKey,
    webhookPublicUrl: config.whatsappWebhookPublicUrl,
    webhookSecret: config.whatsappWebhookSecret,
  };
  const whatsappQueue = new WhatsAppQueue(config.rabbitmqUrl);
  void whatsappQueue.start(async (evt) => {
    await dispatchEvolutionEvent(whatsappDispatchDeps, evt.userId, evt.payload as Record<string, unknown>);
  });

  const whatsappRouter = createWhatsappWebhookRouter({
    pgPool,
    esClient,
    notificationMatcher,
    webhookSecret: config.whatsappWebhookSecret,
    encryptionKey: config.encryptionKey,
    queue: whatsappQueue,
    evolutionApiUrl: config.evolutionApiUrl,
    evolutionApiKey: config.evolutionApiKey,
    webhookPublicUrl: config.whatsappWebhookPublicUrl,
  });
  app.use('/webhook/whatsapp', whatsappRouter);
  app.use('/webhook/whatsapp/*', whatsappRouter);

  // --- Webhook rate limiter (per user, sliding window) ---
  // Guards against misbehaving / looping clients hammering the ingestion pipeline.
  // Typical expected rate is ~1 push/min; 120/min gives 2 orders of headroom.
  const WEBHOOK_MAX_PER_WINDOW = 120;
  const WEBHOOK_WINDOW_MS = 60_000;
  const webhookCounters = new Map<string, { count: number; windowStart: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of webhookCounters) {
      if (now - v.windowStart > WEBHOOK_WINDOW_MS) webhookCounters.delete(k);
    }
  }, WEBHOOK_WINDOW_MS);

  function checkWebhookRate(userId: string): boolean {
    const now = Date.now();
    const entry = webhookCounters.get(userId);
    if (!entry || now - entry.windowStart > WEBHOOK_WINDOW_MS) {
      webhookCounters.set(userId, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= WEBHOOK_MAX_PER_WINDOW;
  }

  // --- Webhook endpoint ---
  //
  // Path-token form `POST /webhook/:token` is DEPRECATED: the credential ends
  // up in every nginx/CDN/proxy access log, browser referrer, and stack trace.
  // Clients should migrate to `POST /webhook` with an `Authorization: Bearer
  // ll5.<token>` header instead. Both paths share the same handler below; when
  // the path-token form is used, we attach a `Deprecation` + `Sunset` header
  // and emit a warning log so operators can see who is still on the old form.
  const handleWebhook = async (req: Request, res: Response): Promise<void> => {
    const pathToken = (req.params as { token?: string }).token;
    const usedPathToken = typeof pathToken === 'string' && pathToken.length > 0;

    if (usedPathToken) {
      // Visible to clients in dev tools / logs so they know to migrate.
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
      res.setHeader('Link', '</webhook>; rel="successor-version"');
      logger.warn('[startServer][webhook] Deprecated path-token form used', {
        userAgent: req.headers['user-agent'],
      });
    }

    const token = (usedPathToken ? pathToken : '') as string;

    // Validate token: try webhook token first, then auth token, then Bearer header
    let userId = config.webhookTokens[token];

    if (!userId && config.authSecret && token) {
      // Try the path-segment token as a real ll5 auth token (Android pre-Bearer flow).
      const result = validateLl5Token(token, config.authSecret);
      if (result.ok) {
        userId = result.claims.uid;
      } else if (result.reason !== 'wrong_prefix' && result.reason !== 'malformed') {
        // Only log when the caller actually attempted to use an ll5 token —
        // not for plain webhook-token strings that lack the prefix.
        logger.debug('[startServer][webhook] Auth token validation failed', { reason: result.reason });
      }
    }

    if (!userId) {
      // Try Bearer header as last resort
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ll5.') && config.authSecret) {
        const authToken = authHeader.slice(7);
        const result = validateLl5Token(authToken, config.authSecret);
        if (result.ok) {
          userId = result.claims.uid;
        } else {
          logger.debug('[startServer][webhook] Bearer token validation failed', { reason: result.reason });
        }
      }
    }

    if (!userId) {
      res.status(401).json({ error: 'Invalid webhook token' });
      return;
    }

    if (!checkWebhookRate(userId)) {
      logger.warn('[startServer][webhook] Rate limit exceeded', { userId });
      res.status(429).json({ error: 'Webhook rate limit exceeded. Try again shortly.' });
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

    // Validate and process items individually — bad items are skipped, not fatal.
    //
    // G1/G2: location points within a batch must be ingested in chronological
    // order so each point's drift check compares against the actual previous
    // point (not a stale ES latest), and out-of-order points don't bypass the
    // check. We therefore parse all items first, then process LOCATION items in
    // ascending-timestamp order while every result is written back at its
    // ORIGINAL index — so `results` order and other item types are unaffected.
    const results: ItemResult[] = new Array<ItemResult>(payload.items.length);
    const typeCounts: Record<string, number> = {};

    interface ParsedEntry { index: number; item: PushItem; }
    const validEntries: ParsedEntry[] = [];

    for (let i = 0; i < payload.items.length; i++) {
      const parsed = PushItemSchema.safeParse(payload.items[i]);
      if (!parsed.success) {
        const errors = parsed.error.errors.map((e: { path: (string | number)[]; message: string }) => `${e.path.join('.')}: ${e.message}`).join('; ');
        const rawType = (payload.items[i] as Record<string, unknown>)?.type;
        logger.warn('[startServer][webhook] Skipping invalid webhook item', { index: i, type: rawType, errors });
        results[i] = { index: i, type: (payload.items[i] as Record<string, unknown>)?.type as string ?? 'unknown', status: 'error', error: errors };
        continue;
      }
      const item = parsed.data;
      typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
      validEntries.push({ index: i, item });
    }

    // Build the processing order: non-location items keep their original order;
    // location items are pulled out and re-sequenced by timestamp ascending.
    const locationEntries = validEntries
      .filter((e) => e.item.type === 'location')
      .sort((a, b) => {
        const ta = new Date((a.item as { timestamp: string }).timestamp).getTime();
        const tb = new Date((b.item as { timestamp: string }).timestamp).getTime();
        if (ta !== tb) return ta - tb;
        return a.index - b.index; // stable for equal timestamps
      });
    const nonLocationEntries = validEntries.filter((e) => e.item.type !== 'location');

    if (locationEntries.length > 1) {
      logger.debug('[startServer][webhook] Ordered location batch chronologically', {
        count: locationEntries.length,
      });
    }

    // Thread the in-batch predecessor across the ordered location sub-sequence.
    const prevPointRef: { current: StoredPoint | null } = { current: null };

    for (const entry of nonLocationEntries) {
      results[entry.index] = await processItem(esClient, userId, entry.item, entry.index, config, pgPool, notificationMatcher);
    }
    for (const entry of locationEntries) {
      results[entry.index] = await processItem(esClient, userId, entry.item, entry.index, config, pgPool, notificationMatcher, prevPointRef);
    }

    // Batch process phone contacts — enrich messaging_contacts display_name
    try {
      const phoneContactItems = payload.items
        .map((raw) => PushItemSchema.safeParse(raw))
        .filter((r) => r.success && r.data.type === 'phone_contact')
        .map((r) => r.data as { sender: string; body: string });

      if (phoneContactItems.length > 0) {
        await processPhoneContacts(pgPool, userId, phoneContactItems);
      }
    } catch (err) {
      // Non-critical — don't fail the webhook response. Still bump the
      // counter so /admin/health.webhook surfaces persistent failures.
      recordWebhookFailure('phone_contacts_enrichment', err);
      logger.error('[startServer][webhook] Phone contacts enrichment failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Clean up deleted phone calendar events: remove phone-sourced events
    // in the pushed time window that weren't in this batch
    try {
      const calendarItems = payload.items
        .map((raw) => PushItemSchema.safeParse(raw))
        .filter((r) => r.success && r.data.type === 'calendar_event')
        .map((r) => r.data as PushCalendarItem);

      if (calendarItems.length > 0) {
        // Reconstruct ids via the SAME helper processCalendar uses to write them,
        // so the must_not exclusion stays aligned (incl. the userId in the hash).
        const pushedIds = new Set(calendarItems.map((item) =>
          phoneEventId(userId, item.title, item.start, item.end ?? item.start),
        ));

        // Find the time window from pushed events
        const starts = calendarItems.map((i) => new Date(i.start).getTime());
        const windowStart = new Date(Math.min(...starts) - 60000).toISOString();
        const windowEnd = new Date(Math.max(...starts) + 60000).toISOString();

        // Delete phone events in this window that aren't in the pushed set
        const staleResult = await esClient.deleteByQuery({
          index: 'll5_awareness_calendar_events',
          refresh: false,
          body: {
            query: {
              bool: {
                filter: [
                  { term: { user_id: userId } },
                  { term: { source: 'phone' } },
                  { range: { start_time: { gte: windowStart, lte: windowEnd } } },
                ],
                must_not: [
                  { ids: { values: [...pushedIds] } },
                ],
              },
            },
          },
        });
        const deleted = (staleResult as { deleted?: number }).deleted ?? 0;
        if (deleted > 0) {
          logger.info('[startServer][webhook] Cleaned up stale phone calendar events', { deleted });
        }
      }
    } catch (err) {
      // Non-critical — don't fail the webhook response. Still bump the
      // counter so /admin/health.webhook surfaces persistent failures.
      recordWebhookFailure('calendar_cleanup', err);
      logger.error('[startServer][webhook] Calendar cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
  };

  // Canonical bearer-header form. Use this from new clients.
  app.post('/webhook', handleWebhook);
  // Deprecated path-token form — kept working for existing clients.
  app.post('/webhook/:token', handleWebhook);

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

  // Step 1: always apply 000_schema_migrations.sql first (creates the ledger
  // table). It's IF NOT EXISTS and re-runnable. Doesn't go through the skip
  // loop — we need the table before we can read the ledger.
  const ledgerFile = '000_schema_migrations.sql';
  if (files.includes(ledgerFile)) {
    const sql = fs.readFileSync(path.join(migrationsDir, ledgerFile), 'utf-8');
    await pool.query(sql);
  } else {
    // Older deploy without the ledger file — bootstrap the table inline.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  // Step 2: first-boot backfill. If the ledger is empty but an older table
  // (chat_messages) already exists, the DB was initialized pre-ledger —
  // mark every migration file as already applied so we don't re-run the old
  // non-idempotent ones.
  const ledgerCount = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM schema_migrations');
  const ledgerEmpty = ledgerCount.rows[0].n === '0';
  if (ledgerEmpty) {
    const legacyCheck = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chat_messages') AS exists",
    );
    if (legacyCheck.rows[0].exists) {
      logger.info('[runMigrations][init] Ledger empty + legacy tables present → backfilling ledger with all existing migration files (none will re-run)');
      for (const file of files) {
        await pool.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file],
        );
      }
    }
  }

  // Step 3: apply pending migrations. Each file runs exactly once per DB.
  const applied = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.filename));

  let runCount = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;
    if (file === ledgerFile) {
      // Already applied above; record it.
      await pool.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      );
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info(`[runMigrations][run] Running migration: ${file}`);
    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      );
      runCount += 1;
    } catch (err) {
      logger.error('[runMigrations][run] Migration failed', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  logger.info('[runMigrations][init] Migrations complete', {
    total_files: files.length,
    applied_this_boot: runCount,
    already_applied: files.length - runCount,
  });
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

  // Start permission-approval listener: pending authority changes → FCM push.
  const { startPermissionApprovalListener } = await import('./utils/permission-approval-listener.js');
  startPermissionApprovalListener(pgPool);

  // Start opencode trigger listener: chat_messages inserts → opencode prompt_async.
  const { startAgentTriggerListener } = await import('./utils/agent-trigger-listener.js');
  startAgentTriggerListener(pgPool);

  app.listen(config.port, () => {
    logger.info(`[startServer][listen] Gateway listening on port ${config.port}`, {
      env: config.nodeEnv,
      tokenCount: Object.keys(config.webhookTokens).length,
      webhook_item_types: ['location', 'message', 'calendar_event', 'device_calendar', 'phone_contact', 'phone_status', 'wifi', 'wifi_scan', 'tracked_device', 'device_activity', 'bluetooth', 'geofence_transition', 'sleep_segment', 'sleep_classify', 'current_place'],
    });
  });
}
