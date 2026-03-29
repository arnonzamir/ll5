import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import type { EnvConfig } from '../utils/env.js';
import { createGoogleCalendarClient } from './google-calendar-client.js';
import { CalendarSyncScheduler } from './calendar-sync.js';
import { CalendarReviewScheduler } from './calendar-review.js';
import { logger } from '../utils/logger.js';

export function startSchedulers(
  config: EnvConfig,
  es: Client,
  pgPool: Pool,
): void {
  const googleClient = createGoogleCalendarClient(config.googleMcpUrl, config.googleMcpApiKey);
  if (!googleClient) {
    logger.info('Schedulers not started — Google MCP not configured');
    return;
  }

  // Get the first user ID from webhook tokens for scheduler context
  const userId = Object.values(config.webhookTokens)[0];
  if (!userId) {
    logger.warn('Schedulers not started — no user ID in webhook tokens');
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
    timezone: config.calendarReviewTimezone,
    userId,
  });
  reviewScheduler.start();

  logger.info('All schedulers started');
}
