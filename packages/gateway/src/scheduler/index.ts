import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import type { EnvConfig } from '../utils/env.js';
import { createGoogleCalendarClient } from './google-calendar-client.js';
import { CalendarSyncScheduler } from './calendar-sync.js';
import { CalendarReviewScheduler } from './calendar-review.js';
import { DailyReviewScheduler } from './daily-review.js';
import { TicklerAlertScheduler } from './tickler-alert.js';
import { GTDHealthScheduler } from './gtd-health.js';
import { WeeklyReviewReminder } from './weekly-review.js';
import { MessageBatchReviewScheduler } from './message-batch-review.js';
import { HeartbeatScheduler } from './heartbeat.js';
import { JournalHealthScheduler } from './journal-health.js';
import { JournalConsolidationScheduler } from './journal-consolidation.js';
import { NarrativeConsolidationScheduler } from './narrative-consolidation.js';
import { HealthPollingScheduler } from './health-polling.js';
import { ResponseTimeoutScheduler } from './response-timeout.js';
import { MCPHealthMonitorScheduler } from './mcp-health-monitor.js';
import { ChannelLivenessMonitor } from './channel-liveness-monitor.js';
import { AgentOutputMonitor } from './agent-output-monitor.js';
import { CharacterRefreshScheduler } from './character-refresh.js';
import { WhatsAppFlowMonitor } from './whatsapp-flow-monitor.js';
import { PhoneLivenessMonitor } from './phone-liveness-monitor.js';
import { MCPStatusPulseScheduler } from './mcp-status-pulse.js';
import { ChatSearchIndexer } from './chat-search-indexer.js';
import { logger } from '../utils/logger.js';

/** Common interface for all schedulers — they all have start() and stop(). */
interface Stoppable {
  start(): void;
  stop(): void;
}

/** Active schedulers keyed by user_id. */
const activeSchedulers = new Map<string, Stoppable[]>();

/** Cluster-wide singletons (not per-user). */
let chatSearchIndexer: ChatSearchIndexer | null = null;

/** Periodic reconciliation timer handle. */
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create and start all scheduler instances for a single user.
 * Returns the list of started schedulers so they can be stopped later.
 */
async function startSchedulersForUser(
  userId: string,
  config: EnvConfig,
  es: Client,
  pgPool: Pool,
): Promise<Stoppable[]> {
  const schedulers: Stoppable[] = [];

  // Read settings from user_settings (unified), fall back to env vars
  let timezone = config.calendarReviewTimezone;
  const sched: Record<string, number> = {};
  try {
    const result = await pgPool.query(
      "SELECT settings->>'timezone' as tz, settings->'scheduler' as sched FROM user_settings WHERE user_id = $1",
      [userId],
    );
    if (result.rows[0]?.tz) {
      timezone = result.rows[0].tz;
    }
    if (result.rows[0]?.sched) {
      Object.assign(sched, result.rows[0].sched);
    }
    logger.info('[startSchedulersForUser][init] Using settings', { userId, timezone, schedulerKeys: Object.keys(sched) });
  } catch (err) {
    // 42P01 = undefined_table — expected on the very first deploy before
    // migrations run. Any other error (connection drop, privilege, schema
    // drift) needs to be loud or we silently fall back to env defaults,
    // which may have wrong timezone/active-hours/intervals.
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      logger.warn('[startSchedulersForUser][init] user_settings missing — using env defaults', { userId });
    } else {
      logger.error('[startSchedulersForUser][init] Failed to read user_settings — falling back to env defaults', {
        userId,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Helper: read scheduler setting with env var fallback
  const s = (key: string, envFallback: number) => (sched[key] as number) ?? envFallback;

  // --- Independent schedulers (always start) ---

  const startHour = s('active_hours_start', config.calendarReviewStartHour);
  const endHour = s('active_hours_end', config.calendarReviewEndHour);

  const gtdHealthScheduler = new GTDHealthScheduler(pgPool, {
    intervalHours: s('gtd_health_hours', config.gtdHealthIntervalHours),
    startHour, endHour, timezone, userId,
  });
  gtdHealthScheduler.start();
  schedulers.push(gtdHealthScheduler);

  const weeklyReviewScheduler = new WeeklyReviewReminder(pgPool, {
    reviewDay: s('weekly_review_day', config.weeklyReviewDay),
    reviewHour: s('weekly_review_hour', config.weeklyReviewHour),
    timezone, userId,
  });
  weeklyReviewScheduler.start();
  schedulers.push(weeklyReviewScheduler);

  const messageBatchScheduler = new MessageBatchReviewScheduler(es, pgPool, {
    intervalMinutes: s('message_batch_minutes', config.messageBatchIntervalMinutes),
    startHour, endHour, timezone, userId,
  });
  messageBatchScheduler.start();
  schedulers.push(messageBatchScheduler);

  const heartbeatScheduler = new HeartbeatScheduler(pgPool, es, {
    silenceMinutes: s('heartbeat_silence_minutes', 30),
    startHour, endHour, timezone, userId,
    lookbackHours: s('schedule_lookback_hours', 1),
    lookaheadHours: s('schedule_lookahead_hours', 3),
  });
  heartbeatScheduler.start();
  schedulers.push(heartbeatScheduler);

  const journalHealthScheduler = new JournalHealthScheduler(es, pgPool, {
    maxSilenceMinutes: s('journal_nudge_minutes', 60),
    startHour, endHour, timezone, userId,
  });
  journalHealthScheduler.start();
  schedulers.push(journalHealthScheduler);

  const healthPollingScheduler = new HealthPollingScheduler(es, pgPool, {
    intervalMinutes: s('health_polling_minutes', 20),
    startHour, endHour, timezone, userId,
  });
  healthPollingScheduler.start();
  schedulers.push(healthPollingScheduler);

  const journalConsolidationScheduler = new JournalConsolidationScheduler(pgPool, {
    consolidationHour: s('consolidation_hour', config.journalConsolidationHour),
    timezone, userId,
  });
  journalConsolidationScheduler.start();
  schedulers.push(journalConsolidationScheduler);

  // Narrative consolidation — default OFF. Enable via
  // user_settings.scheduler.narrative_consolidation_enabled = true.
  // When enabled, fires once a day at configured hour (default 3am, an hour
  // after journal consolidation so the agent has rested user_model first).
  const narrativeConsolidationScheduler = new NarrativeConsolidationScheduler(pgPool, {
    enabled: (sched['narrative_consolidation_enabled'] as unknown as boolean) ?? false,
    consolidationHour: s('narrative_consolidation_hour', 3),
    timezone, userId,
  });
  narrativeConsolidationScheduler.start();
  schedulers.push(narrativeConsolidationScheduler);

  // MCP health + tool-error-rate monitor — cluster-wide, not user-specific,
  // but tied to a user for FCM routing.
  const mcpHealthMonitor = new MCPHealthMonitorScheduler(pgPool, es, {
    intervalMinutes: s('mcp_health_monitor_minutes', 2),
    mcpUrls: config.mcpHealthUrls,
    userId,
    failureThreshold: s('mcp_health_failure_threshold', 2),
    errorRateThreshold: 0.25,
    errorRateMinSamples: 10,
  });
  mcpHealthMonitor.start();
  schedulers.push(mcpHealthMonitor);

  // Channel bridge liveness — detects pending inbound messages piling up
  // because the client-side channel MCP has gone silent.
  const channelLivenessMonitor = new ChannelLivenessMonitor(pgPool, {
    intervalMinutes: s('channel_liveness_minutes', 2),
    stalenessSeconds: s('channel_stale_seconds', 300), // 5 min
    startHour, endHour, timezone, userId,
  });
  channelLivenessMonitor.start();
  schedulers.push(channelLivenessMonitor);

  // Character refresh — re-pushes the essence of the persona a few times a day
  // so long-running sessions (days) don't drift off-character. Agent-internal
  // signal; no FCM push.
  const characterRefreshScheduler = new CharacterRefreshScheduler(pgPool, {
    intervalHours: s('character_refresh_hours', 4),
    startHour, endHour, timezone, userId,
  });
  characterRefreshScheduler.start();
  schedulers.push(characterRefreshScheduler);

  // Agent-output monitor — catches the "channel drains but agent stays silent"
  // failure mode that channel-liveness and mcp-health don't see. If
  // scheduler-triggered system rows are landing but no assistant-outbound is
  // being emitted during active hours, FCM-critical the user.
  const agentOutputMonitor = new AgentOutputMonitor(pgPool, {
    intervalMinutes: s('agent_output_minutes', 15),
    minSystemInbound: s('agent_output_min_triggers', 2),
    silenceHours: s('agent_output_silence_hours', 2),
    lookbackHours: s('agent_output_lookback_hours', 3),
    startHour, endHour, timezone, userId,
  });
  agentOutputMonitor.start();
  schedulers.push(agentOutputMonitor);

  // WhatsApp flow — catches Evolution's ghost-connected failure where state
  // reports open but the webhook has been silent for hours.
  const whatsappFlowMonitor = new WhatsAppFlowMonitor(pgPool, es, {
    intervalMinutes: s('whatsapp_flow_minutes', 15),
    stalenessHours: s('whatsapp_flow_stale_hours', 6),
    startHour, endHour, timezone, userId,
  });
  whatsappFlowMonitor.start();
  schedulers.push(whatsappFlowMonitor);

  // Phone liveness — Android notification/location service dying is invisible
  // from the server side until the heartbeat message happens to notice.
  const phoneLivenessMonitor = new PhoneLivenessMonitor(pgPool, es, {
    intervalMinutes: s('phone_liveness_minutes', 15),
    stalenessHours: s('phone_liveness_stale_hours', 3),
    startHour, endHour, timezone, userId,
  });
  phoneLivenessMonitor.start();
  schedulers.push(phoneLivenessMonitor);

  // Temporary 2h status pulse — fires through 2026-04-21 so the user gets
  // regular visibility while the new monitors stabilise. Self-expires; no
  // cleanup commit needed once the date passes.
  const mcpStatusPulse = new MCPStatusPulseScheduler(pgPool, {
    intervalMinutes: s('mcp_status_pulse_minutes', 120),
    expiresAt: sched['mcp_status_pulse_expires_at'] as unknown as string
      ?? '2026-04-21T18:00:00Z',
    startHour, endHour, timezone, userId,
  });
  mcpStatusPulse.start();
  schedulers.push(mcpStatusPulse);

  // --- Google-dependent schedulers (only start if googleClient exists) ---

  const googleClient = createGoogleCalendarClient(config.googleMcpUrl, config.googleMcpApiKey);
  if (!googleClient) {
    logger.info('[startSchedulersForUser][init] Google-dependent schedulers not started — Google MCP not configured', { userId });
    return schedulers;
  }

  const syncScheduler = new CalendarSyncScheduler(es, googleClient, userId);
  syncScheduler.start();
  schedulers.push(syncScheduler);

  const reviewScheduler = new CalendarReviewScheduler(pgPool, googleClient, {
    startHour, endHour,
    intervalMinutes: s('calendar_review_minutes', config.calendarReviewIntervalMinutes),
    timezone, userId,
  });
  reviewScheduler.start();
  schedulers.push(reviewScheduler);

  const dailyReviewScheduler = new DailyReviewScheduler(pgPool, googleClient, {
    reviewHour: s('morning_briefing_hour', config.dailyReviewHour),
    timezone, userId,
  });
  dailyReviewScheduler.start();
  schedulers.push(dailyReviewScheduler);

  const ticklerAlertScheduler = new TicklerAlertScheduler(pgPool, googleClient, {
    intervalMinutes: s('tickler_alert_minutes', config.ticklerAlertIntervalMinutes),
    startHour, endHour, timezone, userId,
  });
  ticklerAlertScheduler.start();
  schedulers.push(ticklerAlertScheduler);

  const responseTimeoutScheduler = new ResponseTimeoutScheduler(pgPool, {
    timeoutMinutes: s('response_timeout_minutes', 2),
    startHour, endHour, timezone, userId,
  });
  responseTimeoutScheduler.start();
  schedulers.push(responseTimeoutScheduler);

  return schedulers;
}

/**
 * Stop all schedulers for a given user.
 */
function stopSchedulersForUser(userId: string): void {
  const schedulers = activeSchedulers.get(userId);
  if (!schedulers) return;

  for (const scheduler of schedulers) {
    scheduler.stop();
  }
  activeSchedulers.delete(userId);
  logger.info('[stopSchedulersForUser] Stopped schedulers', { userId, count: schedulers.length });
}

/**
 * Reconcile active scheduler sets with the current list of enabled users.
 * Starts schedulers for newly enabled users and stops them for disabled ones.
 */
async function reconcileUsers(
  config: EnvConfig,
  es: Client,
  pgPool: Pool,
): Promise<void> {
  let enabledUserIds: string[];
  try {
    const result = await pgPool.query(
      'SELECT user_id FROM auth_users WHERE enabled = true',
    );
    enabledUserIds = result.rows.map((r: { user_id: string }) => r.user_id);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      logger.warn('[reconcileUsers] auth_users missing — skipping');
    } else {
      logger.error('[reconcileUsers] Failed to query auth_users', {
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (enabledUserIds.length === 0) {
    // No users in DB — don't touch existing schedulers (backward compat with webhookTokens)
    return;
  }

  const currentUserIds = new Set(activeSchedulers.keys());
  const targetUserIds = new Set(enabledUserIds);

  // Start schedulers for newly enabled users
  for (const userId of targetUserIds) {
    if (!currentUserIds.has(userId)) {
      logger.info('[reconcileUsers] New enabled user detected, starting schedulers', { userId });
      try {
        const schedulers = await startSchedulersForUser(userId, config, es, pgPool);
        activeSchedulers.set(userId, schedulers);
      } catch (err) {
        logger.error('[reconcileUsers] Failed to start schedulers for user', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Stop schedulers for disabled/removed users
  for (const userId of currentUserIds) {
    if (!targetUserIds.has(userId)) {
      logger.info('[reconcileUsers] User no longer enabled, stopping schedulers', { userId });
      stopSchedulersForUser(userId);
    }
  }
}

/**
 * Start schedulers for all active users.
 *
 * Strategy:
 * 1. Query auth_users for all enabled users
 * 2. For each user, read their settings and start a full scheduler set
 * 3. Set up periodic reconciliation (every 5 min) to detect new/disabled users
 * 4. If no users found in DB, fall back to the legacy webhookTokens approach
 */
export async function startSchedulers(
  config: EnvConfig,
  es: Client,
  pgPool: Pool,
): Promise<void> {
  // Try to get active users from auth_users table
  let userIds: string[] = [];
  try {
    const result = await pgPool.query(
      'SELECT user_id FROM auth_users WHERE enabled = true',
    );
    userIds = result.rows.map((r: { user_id: string }) => r.user_id);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      logger.warn('[startSchedulers][init] auth_users missing — falling back to webhookTokens');
    } else {
      logger.error('[startSchedulers][init] Failed to query auth_users', {
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fall back to webhookTokens if no users found in DB
  if (userIds.length === 0) {
    const fallbackUserId = Object.values(config.webhookTokens)[0];
    if (!fallbackUserId) {
      logger.warn('[startSchedulers][init] Schedulers not started — no users in DB and no webhook tokens');
      return;
    }
    logger.info('[startSchedulers][init] No users in auth_users, falling back to webhookTokens', { userId: fallbackUserId });
    userIds = [fallbackUserId];
  }

  // Start scheduler sets for each user
  for (const userId of userIds) {
    try {
      const schedulers = await startSchedulersForUser(userId, config, es, pgPool);
      activeSchedulers.set(userId, schedulers);
      logger.info('[startSchedulers][init] Schedulers started for user', {
        userId,
        schedulerCount: schedulers.length,
      });
    } catch (err) {
      logger.error('[startSchedulers][init] Failed to start schedulers for user', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('[startSchedulers][init] All scheduler sets started', {
    userCount: activeSchedulers.size,
    users: [...activeSchedulers.keys()],
  });

  // Cluster-wide chat search indexer — single process tails NOTIFY and
  // mirrors chat into ES. Independent of per-user scheduler sets.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    chatSearchIndexer = new ChatSearchIndexer(pgPool, es, dbUrl);
    try {
      await chatSearchIndexer.start();
    } catch (err) {
      logger.error('[startSchedulers][init] ChatSearchIndexer start failed — search will fall back to ILIKE', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    logger.warn('[startSchedulers][init] DATABASE_URL not set — chat search indexer skipped');
  }

  // Set up periodic reconciliation to detect new/disabled users
  reconcileTimer = setInterval(
    () => void reconcileUsers(config, es, pgPool),
    RECONCILE_INTERVAL_MS,
  );
}

/**
 * Stop all schedulers for all users and clear reconciliation timer.
 * Useful for graceful shutdown.
 */
export function stopAllSchedulers(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }

  if (chatSearchIndexer) {
    chatSearchIndexer.stop();
    chatSearchIndexer = null;
  }

  for (const userId of activeSchedulers.keys()) {
    stopSchedulersForUser(userId);
  }
  logger.info('[stopAllSchedulers] All schedulers stopped');
}

/** Exposed for admin endpoints / one-shot backfill. */
export function getChatSearchIndexer(): ChatSearchIndexer | null {
  return chatSearchIndexer;
}
