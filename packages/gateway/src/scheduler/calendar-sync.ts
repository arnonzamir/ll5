import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import type { GoogleCalendarClient } from './google-calendar-client.js';
import { logger } from '../utils/logger.js';
import { raiseAlert, clearAlert } from '../utils/alerting.js';

/**
 * True when a calendar-fetch error is a Google OAUTH failure (refresh token
 * revoked/expired, or no token stored) rather than a transient blip. The google
 * MCP surfaces these as a 500 whose body carries the message from
 * google-client.ts: "Google account not connected…" or "Failed to refresh
 * Google access token: …invalid_grant…". We deliberately do NOT match a bare
 * 401/403 (that would be the gateway↔MCP API-key auth, a different problem).
 */
export function isGoogleAuthError(message: string): boolean {
  return /invalid_grant|account not connected|refresh google access token|get_auth_url|token (has been )?(expired|revoked)|invalid_rapt|unauthorized_client/i.test(message);
}

/**
 * Syncs Google Calendar events into the awareness ES index.
 * Uses deterministic document IDs to prevent duplicates.
 * Runs periodically (every 30 minutes). Also doubles as the Google-OAUTH
 * liveness check: a successful fetch clears `service.google-auth`; an auth
 * failure raises it (the old health checks only proved the service was up,
 * never that the token was still valid).
 */
export class CalendarSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private es: Client,
    private googleClient: GoogleCalendarClient,
    private userId: string,
    private pool: Pool,
    private intervalMs: number = 30 * 60 * 1000, // 30 minutes
  ) {}

  start(): void {
    logger.info('[CalendarSyncScheduler][start] Calendar sync scheduler started', { intervalMs: this.intervalMs });
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
    // Fetch events for the next 7 days
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // --- Phase 1: fetch from Google (this is the OAuth liveness probe) ---
    let events;
    try {
      events = await this.googleClient.getEvents(from, to);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isGoogleAuthError(message)) {
        logger.error('[CalendarSyncScheduler][sync] Google OAuth disconnected', { error: message });
        await raiseAlert(this.pool, {
          userId: this.userId,
          key: 'service.google-auth',
          severity: 'critical',
          summary: 'Google disconnected (Calendar + Gmail)',
          value: 'OAuth refresh failed',
          expected: 'connected',
          suggestion: 'Refresh token invalid/revoked — Calendar + Gmail are dark. Call `get_auth_url` (google MCP) and push the one-tap reconnect link to the user so they can re-auth from the app (web or phone); they can also use dashboard Settings → Calendar.',
        });
      } else {
        // Transient (network / google MCP down / ES) — don't alert; the
        // mcp-health-monitor owns service-down, this owns OAuth specifically.
        logger.warn('[CalendarSyncScheduler][sync] Calendar fetch failed (non-blocking)', { error: message });
      }
      return;
    }
    // Fetch succeeded → the token is valid; resolve any standing auth alert.
    await clearAlert(this.pool, this.userId, 'service.google-auth');

    // --- Phase 2: write to ES (an ES error here is NOT an auth problem) ---
    try {
      if (events.length === 0) {
        logger.debug('[CalendarSyncScheduler][sync] No events found');
        return;
      }

      const nowStr = now.toISOString();
      const operations: Record<string, unknown>[] = [];

      for (const event of events) {
        // User-namespaced doc id — MUST match the google MCP's
        // ESCalendarEventRepository scheme (`${userId}::google-${eventId}`) so the
        // two writers of ll5_awareness_calendar_events converge on one doc per
        // event instead of producing a legacy/scoped duplicate pair. See
        // docs/decisions/DECISION-006.
        const docId = `${this.userId}::google-${event.event_id}`;
        const attendees = event.attendees.map((a) => a.name ?? a.email);

        // Partial update doc: only the volatile scheduling fields. Crucially it
        // omits created_at (so the original insert time survives) and omits
        // title/location/source (so a previously merged enrichment from a phone
        // push is NOT reverted back to the bare Google title/'google' source).
        const partialDoc: Record<string, unknown> = {
          start_time: event.start,
          end_time: event.end,
          calendar_name: event.calendar_name,
          all_day: event.all_day,
          attendees,
          updated_at: nowStr,
        };
        if (event.description != null) partialDoc.description = event.description;

        // Upsert branch: the full doc used ONLY when the event does not yet
        // exist. This is the only place created_at, title, location and the
        // 'google' source are set.
        const upsertDoc: Record<string, unknown> = {
          user_id: this.userId,
          title: event.title,
          description: event.description,
          start_time: event.start,
          end_time: event.end,
          location: event.location,
          calendar_name: event.calendar_name,
          source: 'google',
          all_day: event.all_day,
          attendees,
          created_at: nowStr,
          updated_at: nowStr,
        };

        operations.push(
          { update: { _index: 'll5_awareness_calendar_events', _id: docId } },
          { doc: partialDoc, upsert: upsertDoc },
        );
      }

      if (operations.length > 0) {
        const result = await this.es.bulk({ operations, refresh: false }) as { errors?: boolean };
        logger.info('[CalendarSyncScheduler][sync] calendar_sync', {
          event_count: events.length,
          op: 'update_upsert',
          errors: result?.errors ?? false,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[CalendarSyncScheduler][sync] ES upsert failed (non-blocking)', { error: message });
    }
  }
}
