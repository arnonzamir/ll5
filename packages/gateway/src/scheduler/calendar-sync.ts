import type { Client } from '@elastic/elasticsearch';
import type { GoogleCalendarClient } from './google-calendar-client.js';
import { logger } from '../utils/logger.js';

/**
 * Syncs Google Calendar events into the awareness ES index.
 * Uses deterministic document IDs to prevent duplicates.
 * Runs periodically (every 30 minutes).
 */
export class CalendarSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private es: Client,
    private googleClient: GoogleCalendarClient,
    private userId: string,
    private intervalMs: number = 30 * 60 * 1000, // 30 minutes
  ) {}

  start(): void {
    logger.info('Calendar sync scheduler started', { intervalMs: this.intervalMs });
    // Run immediately, then on interval
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sync(): Promise<void> {
    try {
      // Fetch events for the next 7 days
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const events = await this.googleClient.getEvents(from, to);

      if (events.length === 0) {
        logger.debug('Calendar sync: no events found');
        return;
      }

      const nowStr = now.toISOString();
      const operations: Record<string, unknown>[] = [];

      for (const event of events) {
        const docId = `google-${event.event_id}`;

        operations.push(
          { index: { _index: 'll5_awareness_calendar_events', _id: docId } },
          {
            user_id: this.userId,
            title: event.title,
            description: event.description,
            start_time: event.start,
            end_time: event.end,
            location: event.location,
            calendar_name: event.calendar_name,
            source: 'google',
            all_day: event.all_day,
            attendees: event.attendees.map((a) => a.name ?? a.email),
            created_at: nowStr,
            updated_at: nowStr,
          },
        );
      }

      if (operations.length > 0) {
        await this.es.bulk({ operations, refresh: false });
        logger.info('Calendar sync completed', { eventCount: events.length });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Calendar sync failed (non-blocking)', { error: message });
    }
  }
}
