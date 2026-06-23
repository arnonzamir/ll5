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
import { CoachScanScheduler } from './coach-scan.js';
import { CompositeTriggerScheduler } from './composite-triggers.js';
import { MessageBatchReviewScheduler } from './message-batch-review.js';
import { HeartbeatScheduler } from './heartbeat.js';
import { JournalHealthScheduler } from './journal-health.js';
import { JournalConsolidationScheduler } from './journal-consolidation.js';
import { NarrativeConsolidationScheduler } from './narrative-consolidation.js';
import { StuckMessageSweep } from './stuck-message-sweep.js';
import { HealthPollingScheduler } from './health-polling.js';
import { ResponseTimeoutScheduler } from './response-timeout.js';
import { MCPHealthMonitorScheduler } from './mcp-health-monitor.js';
import { AgentOutputMonitor } from './agent-output-monitor.js';
import { CharacterRefreshScheduler } from './character-refresh.js';
import { WhatsAppFlowMonitor } from './whatsapp-flow-monitor.js';
import { PhoneLivenessMonitor } from './phone-liveness-monitor.js';
import { MetricsMonitor } from './metrics-monitor.js';
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

  // Coach scan — weekly STRATEGIC review (goals/narratives/commitments + the
  // 2-4-week calendar horizon). Strategic counterpart to the tactical weekly
  // review above; fires its own [Coach Scan] cue once per week.
  const coachScanScheduler = new CoachScanScheduler(pgPool, {
    scanDay: s('coach_scan_day', config.coachScanDay),
    scanHour: s('coach_scan_hour', config.coachScanHour),
    timezone, userId,
  });
  coachScanScheduler.start();
  schedulers.push(coachScanScheduler);

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

  // Narrative freshness — default ON (2026-05-22; upgraded to cadenced
  // server-selected freshness 2026-06-23). Disable per-user via
  // user_settings.scheduler.narrative_consolidation_enabled = false.
  // Fires every intervalHours within the active window; itself selects the
  // narratives with new activity since last summary (debounced), so the agent
  // refreshes exactly those rather than scanning everything once a day.
  const narrativeConsolidationScheduler = new NarrativeConsolidationScheduler(es, pgPool, {
    enabled: (sched['narrative_consolidation_enabled'] as unknown as boolean) ?? true,
    intervalHours: s('narrative_freshness_interval_hours', 3),
    fireWithinMinutes: s('narrative_freshness_fire_within_minutes', 10),
    // Around the clock (every intervalHours). Consolidation/promotion is SILENT
    // (no push), and the agent reliably clears silent system work in the quiet
    // overnight hours — during busy daytime it starves it behind real-time events.
    // So the overnight ticks (0/3/6) are the dependable ones that clear the backlog.
    activeStartHour: s('narrative_freshness_start_hour', 0),
    activeEndHour: s('narrative_freshness_end_hour', 23),
    debounceHours: s('narrative_freshness_debounce_hours', 6),
    activeWindowDays: s('narrative_freshness_window_days', 14),
    maxNarratives: s('narrative_freshness_max', 15),
    promoteThreshold: s('narrative_freshness_promote_threshold', 3),
    maxOrphans: s('narrative_freshness_max_orphans', 10),
    timezone, userId,
  });
  narrativeConsolidationScheduler.start();
  schedulers.push(narrativeConsolidationScheduler);

  // Stuck-message sweep — flips long-pending/processing system rows to
  // delivered so the table doesn't accumulate handled-but-unmarked rows.
  // Channel MCP marks system rows delivered directly on delivery (ll5-run
  // side); this is the safety net.
  const stuckMessageSweep = new StuckMessageSweep(pgPool, {
    intervalMinutes: s('stuck_message_sweep_minutes', 10),
    stuckAfterMinutes: s('stuck_message_after_minutes', 30),
    channels: ['system'],
    userId,
  });
  stuckMessageSweep.start();
  schedulers.push(stuckMessageSweep);

  // MCP health + tool-error-rate monitor — cluster-wide, not user-specific,
  // but tied to a user for FCM routing. Probes both /health (HTTP) and
  // tools/list (streamable-HTTP MCP) on every cycle — the latter catches the
  // "connected but cannot list tools" ghost mode that /health alone misses.
  const mcpHealthMonitor = new MCPHealthMonitorScheduler(pgPool, es, {
    intervalMinutes: s('mcp_health_monitor_minutes', 2),
    mcpUrls: config.mcpHealthUrls,
    userId,
    failureThreshold: s('mcp_health_failure_threshold', 2),
    errorRateThreshold: 0.25,
    errorRateMinSamples: 10,
    authSecret: config.authSecret,
    apiKey: config.apiKey,
  });
  mcpHealthMonitor.start();
  schedulers.push(mcpHealthMonitor);

  // Character refresh — re-pushes the essence of the persona a few times a day
  // so long-running sessions (days) don't drift off-character. Agent-internal
  // signal; no FCM push.
  const characterRefreshScheduler = new CharacterRefreshScheduler(pgPool, {
    intervalHours: s('character_refresh_hours', 4),
    startHour, endHour, timezone, userId,
  });
  characterRefreshScheduler.start();
  schedulers.push(characterRefreshScheduler);

  // Agent-output monitor — primary "agent isn't keeping up" signal on the
  // server-agent topology. Catches the "channel drains but agent stays silent"
  // failure mode that mcp-health alone can't see. If scheduler-triggered
  // system rows are landing but no assistant-outbound is being emitted during
  // active hours, FCM-critical the user. Throttle-aware by design (watches
  // outbound flow, not pending queue depth). Default silence 0.5h (30min)
  // strikes the balance between catching real hangs quickly and tolerating
  // long tool-call clusters (narrative consolidation, weekly review, etc.).
  const agentOutputMonitor = new AgentOutputMonitor(pgPool, es, {
    intervalMinutes: s('agent_output_minutes', 15),
    minSystemInbound: s('agent_output_min_triggers', 2),
    silenceHours: s('agent_output_silence_hours', 0.5),
    lookbackHours: s('agent_output_lookback_hours', 3),
    startHour, endHour, timezone, userId,
  });
  agentOutputMonitor.start();
  schedulers.push(agentOutputMonitor);

  // WhatsApp flow — catches Evolution's ghost-connected failure where state
  // reports open but the webhook has been silent for hours.
  const whatsappFlowMonitor = new WhatsAppFlowMonitor(pgPool, es, {
    intervalMinutes: s('whatsapp_flow_minutes', 10),
    // 2h (was 6h): WhatsApp is high-volume during active hours, so a 2h gap is
    // already a strong outage signal — catch it fast. Alerts now reach the
    // agent + repeat + show in the apps via the alert spine.
    stalenessHours: s('whatsapp_flow_stale_hours', 2),
    startHour, endHour, timezone, userId,
  });
  whatsappFlowMonitor.start();
  schedulers.push(whatsappFlowMonitor);

  // Metrics watchdog — declarative companion: the remaining input channels
  // (slack/gmail/sms freshness, baseline-gated) + Elasticsearch cluster health,
  // all funneled through the alert spine (agent + repeat + app banner).
  const metricsMonitor = new MetricsMonitor(pgPool, es, {
    intervalMinutes: s('metrics_monitor_minutes', 5),
    baselineDays: s('metrics_baseline_days', 7),
    startHour, endHour, timezone, userId,
  });
  metricsMonitor.start();
  schedulers.push(metricsMonitor);

  // Phone liveness — Android notification/location service dying is invisible
  // from the server side until the heartbeat message happens to notice.
  const phoneLivenessMonitor = new PhoneLivenessMonitor(pgPool, es, {
    intervalMinutes: s('phone_liveness_minutes', 15),
    stalenessHours: s('phone_liveness_stale_hours', 3),
    startHour, endHour, timezone, userId,
  });
  phoneLivenessMonitor.start();
  schedulers.push(phoneLivenessMonitor);

  // --- Google-dependent schedulers (only start if googleClient exists) ---

  const googleClient = createGoogleCalendarClient(config.googleMcpUrl, config.googleMcpApiKey);
  if (!googleClient) {
    logger.info('[startSchedulersForUser][init] Google-dependent schedulers not started — Google MCP not configured', { userId });
    return schedulers;
  }

  const syncScheduler = new CalendarSyncScheduler(es, googleClient, userId, pgPool);
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
  }, es);
  dailyReviewScheduler.start();
  schedulers.push(dailyReviewScheduler);

  const ticklerAlertScheduler = new TicklerAlertScheduler(pgPool, googleClient, {
    intervalMinutes: s('tickler_alert_minutes', config.ticklerAlertIntervalMinutes),
    startHour, endHour, timezone, userId,
  });
  ticklerAlertScheduler.start();
  schedulers.push(ticklerAlertScheduler);

  const responseTimeoutScheduler = new ResponseTimeoutScheduler(pgPool, {
    // Seconds-granularity; falls back to the legacy minutes key (×60) then 120s.
    timeoutSeconds: s('response_timeout_seconds', s('response_timeout_minutes', 2) * 60),
    startHour, endHour, timezone, userId,
  });
  responseTimeoutScheduler.start();
  schedulers.push(responseTimeoutScheduler);

  // Composite triggers — event-driven proactivity that can't be fired from a
  // single webhook: free-block-opened (M5) and important-contact-unanswered
  // (R1). Ticks conservatively (~3 min) and de-dupes heavily so it surfaces a
  // situation the moment it crosses threshold, NOT every tick. (The arrival
  // composite L1 is fired straight from the location processor.)
  const compositeTriggerScheduler = new CompositeTriggerScheduler(pgPool, es, googleClient, {
    intervalMinutes: s('composite_trigger_minutes', config.compositeTriggerMinutes),
    startHour, endHour, timezone, userId,
  });
  compositeTriggerScheduler.start();
  schedulers.push(compositeTriggerScheduler);

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
