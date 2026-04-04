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

  // Read timezone from user_settings (unified), fall back to env var
  let timezone = config.calendarReviewTimezone;
  try {
    const result = await pgPool.query(
      "SELECT settings->>'timezone' as tz FROM user_settings WHERE user_id = $1",
      [userId],
    );
    if (result.rows[0]?.tz) {
      timezone = result.rows[0].tz;
      logger.info('[startSchedulers][init] Using timezone from user_settings', { timezone });
    }
  } catch {
    // Table may not exist yet on first deploy — use env var
  }

  // --- Independent schedulers (always start) ---

  // GTD health check: periodic reminder
  const gtdHealthScheduler = new GTDHealthScheduler(pgPool, {
    intervalHours: config.gtdHealthIntervalHours,
    startHour: config.calendarReviewStartHour,
    endHour: config.calendarReviewEndHour,
    timezone,
    userId,
  });
  gtdHealthScheduler.start();

  // Weekly review reminder
  const weeklyReviewScheduler = new WeeklyReviewReminder(pgPool, {
    reviewDay: config.weeklyReviewDay,
    reviewHour: config.weeklyReviewHour,
    timezone,
    userId,
  });
  weeklyReviewScheduler.start();

  // Message batch review
  const messageBatchScheduler = new MessageBatchReviewScheduler(es, pgPool, {
    intervalMinutes: config.messageBatchIntervalMinutes,
    startHour: config.calendarReviewStartHour,
    endHour: config.calendarReviewEndHour,
    timezone,
    userId,
  });
  messageBatchScheduler.start();

  // Heartbeat: nudge agent with current time after silence
  const heartbeatScheduler = new HeartbeatScheduler(pgPool, {
    silenceMinutes: 60,
    startHour: config.calendarReviewStartHour,
    endHour: config.calendarReviewEndHour,
    timezone,
    userId,
  });
  heartbeatScheduler.start();

  // Journal health + proactivity nudge: remind agent if silent too long
  const journalHealthScheduler = new JournalHealthScheduler(es, pgPool, {
    maxSilenceMinutes: 60,
    startHour: config.calendarReviewStartHour,
    endHour: config.calendarReviewEndHour,
    timezone,
    userId,
  });
  journalHealthScheduler.start();

  // Journal consolidation: nightly trigger to consolidate journal → user model
  const journalConsolidationScheduler = new JournalConsolidationScheduler(pgPool, {
    consolidationHour: config.journalConsolidationHour,
    timezone,
    userId,
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
    startHour: config.calendarReviewStartHour,
    endHour: config.calendarReviewEndHour,
    intervalMinutes: config.calendarReviewIntervalMinutes,
    timezone,
    userId,
  });
  reviewScheduler.start();

  // Daily review (morning briefing)
  const dailyReviewScheduler = new DailyReviewScheduler(pgPool, googleClient, {
    reviewHour: config.dailyReviewHour,
    timezone,
    userId,
  });
  dailyReviewScheduler.start();

  // Tickler alerts
  const ticklerAlertScheduler = new TicklerAlertScheduler(pgPool, googleClient, {
    intervalMinutes: config.ticklerAlertIntervalMinutes,
    startHour: config.calendarReviewStartHour,
    endHour: config.calendarReviewEndHour,
    timezone,
    userId,
  });
  ticklerAlertScheduler.start();

  logger.info('[startSchedulers][init] All schedulers started');
}
