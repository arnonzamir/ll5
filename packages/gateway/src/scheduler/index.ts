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
import { logger } from '../utils/logger.js';

export async function startSchedulers(
  config: EnvConfig,
  es: Client,
  pgPool: Pool,
): Promise<void> {
  // Get the first user ID from webhook tokens for scheduler context
  const userId = Object.values(config.webhookTokens)[0];
  if (!userId) {
    logger.warn('[startSchedulers][init] Schedulers not started — no user ID in webhook tokens');
    return;
  }

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
    logger.info('[startSchedulers][init] Using settings from user_settings', { timezone, schedulerKeys: Object.keys(sched) });
  } catch {
    // Table may not exist yet on first deploy — use env vars
  }

  // Helper: read scheduler setting with env var fallback
  const s = (key: string, envFallback: number) => (sched[key] as number) ?? envFallback;

  // --- Independent schedulers (always start) ---

  const startHour = s('active_hours_start', config.calendarReviewStartHour);
  const endHour = s('active_hours_end', config.calendarReviewEndHour);

  // GTD health check: periodic reminder
  const gtdHealthScheduler = new GTDHealthScheduler(pgPool, {
    intervalHours: s('gtd_health_hours', config.gtdHealthIntervalHours),
    startHour, endHour, timezone, userId,
  });
  gtdHealthScheduler.start();

  // Weekly review reminder
  const weeklyReviewScheduler = new WeeklyReviewReminder(pgPool, {
    reviewDay: s('weekly_review_day', config.weeklyReviewDay),
    reviewHour: s('weekly_review_hour', config.weeklyReviewHour),
    timezone, userId,
  });
  weeklyReviewScheduler.start();

  // Message batch review
  const messageBatchScheduler = new MessageBatchReviewScheduler(es, pgPool, {
    intervalMinutes: s('message_batch_minutes', config.messageBatchIntervalMinutes),
    startHour, endHour, timezone, userId,
  });
  messageBatchScheduler.start();

  // Heartbeat: nudge agent with time + schedule context after silence
  const heartbeatScheduler = new HeartbeatScheduler(pgPool, es, {
    silenceMinutes: s('heartbeat_silence_minutes', 60),
    startHour, endHour, timezone, userId,
    lookbackHours: s('schedule_lookback_hours', 1),
    lookaheadHours: s('schedule_lookahead_hours', 3),
  });
  heartbeatScheduler.start();

  // Journal health + proactivity nudge: remind agent if silent too long
  const journalHealthScheduler = new JournalHealthScheduler(es, pgPool, {
    maxSilenceMinutes: s('journal_nudge_minutes', 60),
    startHour, endHour, timezone, userId,
  });
  journalHealthScheduler.start();

  // Journal consolidation: nightly trigger
  const journalConsolidationScheduler = new JournalConsolidationScheduler(pgPool, {
    consolidationHour: s('consolidation_hour', config.journalConsolidationHour),
    timezone, userId,
  });
  journalConsolidationScheduler.start();

  // --- Google-dependent schedulers (only start if googleClient exists) ---

  const googleClient = createGoogleCalendarClient(config.googleMcpUrl, config.googleMcpApiKey);
  if (!googleClient) {
    logger.info('[startSchedulers][init] Google-dependent schedulers not started — Google MCP not configured');
    logger.info('[startSchedulers][init] Independent schedulers started (GTD health, weekly review, message batch)');
    return;
  }

  // Calendar sync: every 30 minutes
  const syncScheduler = new CalendarSyncScheduler(es, googleClient, userId);
  syncScheduler.start();

  // Calendar review: configurable interval during active hours
  const reviewScheduler = new CalendarReviewScheduler(pgPool, googleClient, {
    startHour, endHour,
    intervalMinutes: s('calendar_review_minutes', config.calendarReviewIntervalMinutes),
    timezone, userId,
  });
  reviewScheduler.start();

  // Daily review (morning briefing)
  const dailyReviewScheduler = new DailyReviewScheduler(pgPool, googleClient, {
    reviewHour: s('morning_briefing_hour', config.dailyReviewHour),
    timezone, userId,
  });
  dailyReviewScheduler.start();

  // Tickler alerts
  const ticklerAlertScheduler = new TicklerAlertScheduler(pgPool, googleClient, {
    intervalMinutes: s('tickler_alert_minutes', config.ticklerAlertIntervalMinutes),
    startHour, endHour, timezone, userId,
  });
  ticklerAlertScheduler.start();

  logger.info('[startSchedulers][init] All schedulers started');
}
