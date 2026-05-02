import { z } from 'zod';
import { google } from 'googleapis';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import type { CalendarConfigRepository } from '../repositories/interfaces/calendar-config.repository.js';
import type { ESCalendarEventRepository } from '../repositories/elasticsearch/calendar-event.repository.js';
import { getAuthenticatedClient, type GoogleClientConfig } from '../utils/google-client.js';
import { logAudit, sessionTimezone } from '@ll5/shared';
import { logger } from '../utils/logger.js';

const TICKLER_CALENDAR_NAME = 'LL5 System';
const TICKLER_COLOR = '#e67c73'; // flamingo

/** Map friendly recurrence names to RRULE strings. */
const RECURRENCE_MAP: Record<string, string> = {
  daily: 'RRULE:FREQ=DAILY',
  weekly: 'RRULE:FREQ=WEEKLY',
  weekdays: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  monthly: 'RRULE:FREQ=MONTHLY',
  yearly: 'RRULE:FREQ=YEARLY',
};

/** Resolve a recurrence input (friendly name or raw RRULE) to an RRULE string array for Google Calendar. */
function resolveRecurrence(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const mapped = RECURRENCE_MAP[input.toLowerCase()];
  if (mapped) return [mapped];
  // Accept raw RRULE strings directly
  if (input.toUpperCase().startsWith('RRULE:')) return [input];
  // Unknown — treat as raw just in case
  return [`RRULE:${input}`];
}

/**
 * Find the tickler calendar. Checks config first, then searches Google Calendar
 * list by name and registers it. Never creates a new calendar.
 */
async function findTicklerCalendar(
  config: GoogleClientConfig,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
  userId: string,
): Promise<string> {
  // 1. Check config DB
  const existing = await calendarConfigRepo.getByRole(userId, 'tickler');
  if (existing) {
    return existing.calendar_id;
  }

  // 2. Search Google Calendar list for a calendar named "LL5 System" (or similar)
  const auth = await getAuthenticatedClient(config, tokenRepo, userId);
  const calendarApi = google.calendar({ version: 'v3', auth });

  const listResponse = await calendarApi.calendarList.list({ maxResults: 100 });
  const calendars = listResponse.data.items ?? [];

  const match = calendars.find((c) =>
    c.summary?.toLowerCase().includes('ll5') ||
    c.summary?.toLowerCase().includes('tickler'),
  );

  if (match?.id) {
    // Found it — register in config
    await calendarConfigRepo.upsert(userId, {
      calendar_id: match.id,
      calendar_name: match.summary ?? TICKLER_CALENDAR_NAME,
      color: TICKLER_COLOR,
      role: 'tickler',
    });
    logger.info('[findTicklerCalendar] Found and registered tickler calendar', { calendarId: match.id, name: match.summary });
    return match.id;
  }

  throw new Error(
    `No tickler calendar found. Create a Google Calendar named "${TICKLER_CALENDAR_NAME}" manually, then retry.`,
  );
}

export function registerTicklerTools(
  server: McpServer,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
  esRepo: ESCalendarEventRepository | null,
  config: GoogleClientConfig,
  getUserId: () => string,
): void {

  // ---------------------------------------------------------------------------
  // create_tickler
  // ---------------------------------------------------------------------------
  server.tool(
    'create_tickler',
    'Create a tickler reminder on the LL5 System calendar. Use for temporal nudges — things to think about or prepare for at a certain time. NOT for meetings or appointments (use create_event for those).',
    {
      title: z.string().describe('What to be reminded about'),
      due_date: z.string().describe('When this should surface (YYYY-MM-DD)'),
      due_time: z.string().optional().describe('Specific time (HH:MM, 24h format). Default: 08:00. Pass "all_day" to create an all-day event.'),
      description: z.string().optional().describe('Additional context or notes'),
      category: z.string().optional().describe('Category: health, admin, planning, financial, social, errands'),
      recurrence: z.string().optional().describe('Recurrence pattern. Friendly names: "daily", "weekly", "weekdays", "monthly", "yearly". Or a raw RRULE string like "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR". Omit for one-off ticklers.'),
    },
    async ({ title, due_date, due_time, description, category, recurrence }) => {
      const userId = getUserId();
      const calendarId = await findTicklerCalendar(config, tokenRepo, calendarConfigRepo, userId);
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });
      const tz = sessionTimezone();

      const fullTitle = category ? `[${category}] ${title}` : title;
      const effectiveTime = (!due_time || due_time === 'all_day') ? null : due_time;
      const isAllDay = due_time === 'all_day';
      const resolvedTime = effectiveTime ?? (isAllDay ? null : '08:00');

      const eventBody: Record<string, unknown> = {
        summary: fullTitle,
        description: description ?? undefined,
        colorId: '4', // flamingo in Google Calendar color IDs
      };

      if (isAllDay) {
        // All-day event: end date is the next day
        const endDate = new Date(due_date);
        endDate.setDate(endDate.getDate() + 1);
        const endDateStr = endDate.toISOString().split('T')[0];
        eventBody.start = { date: due_date };
        eventBody.end = { date: endDateStr };
      } else {
        const startDateTime = `${due_date}T${resolvedTime}:00`;
        const endDate = new Date(startDateTime);
        endDate.setMinutes(endDate.getMinutes() + 30); // 30-min default duration
        eventBody.start = { dateTime: startDateTime, timeZone: tz };
        eventBody.end = { dateTime: endDate.toISOString(), timeZone: tz };
      }

      // Add a popup reminder
      eventBody.reminders = {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: isAllDay ? 480 : 30 }, // 8h before all-day, 30min before timed
        ],
      };

      // Add recurrence rule if specified
      const rrule = resolveRecurrence(recurrence);
      if (rrule) {
        eventBody.recurrence = rrule;
      }

      const response = await calendarApi.events.insert({
        calendarId,
        requestBody: eventBody as Parameters<typeof calendarApi.events.insert>[0] extends { requestBody?: infer R } ? R : never,
      });

      logAudit({ user_id: userId, source: 'calendar', action: 'create', entity_type: 'tickler', entity_id: response.data.id ?? '', summary: `Created tickler: ${fullTitle}` });

      // Write-through to ES
      if (esRepo) {
        await esRepo.upsertFromGoogle(userId, {
          event_id: response.data.id ?? '',
          calendar_id: calendarId,
          calendar_name: TICKLER_CALENDAR_NAME,
          calendar_color: TICKLER_COLOR,
          title: fullTitle,
          start: response.data.start?.dateTime ?? response.data.start?.date ?? due_date,
          end: response.data.end?.dateTime ?? response.data.end?.date ?? due_date,
          all_day: isAllDay,
          description,
          html_link: response.data.htmlLink ?? undefined,
          status: 'confirmed',
        }, true);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            event_id: response.data.id ?? '',
            title: fullTitle,
            due_date,
            due_time: due_time ?? 'all-day',
            recurring: !!rrule,
            recurrence: recurrence ?? null,
            calendar: TICKLER_CALENDAR_NAME,
          }, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_ticklers
  // ---------------------------------------------------------------------------
  server.tool(
    'list_ticklers',
    'List upcoming tickler reminders from the LL5 System calendar.',
    {
      from: z.string().optional().describe('Start of range (YYYY-MM-DD or ISO 8601). Default: today'),
      to: z.string().optional().describe('End of range (YYYY-MM-DD or ISO 8601). Default: 7 days from now'),
      include_past: z.boolean().optional().describe('Include past ticklers (default: false)'),
    },
    async ({ from, to, include_past }) => {
      const userId = getUserId();
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const defaultFrom = include_past
        ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
        : startOfDay.toISOString();
      const defaultTo = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const timeMin = from ? new Date(from).toISOString() : defaultFrom;
      const timeMax = to ? new Date(to).toISOString() : defaultTo;

      // Read from ES if available
      if (esRepo) {
        try {
          const docs = await esRepo.query(userId, {
            from: timeMin, to: timeMax, isTickler: true, limit: 100,
          });

          const ticklers = docs.map((d) => ({
            event_id: d.google_event_id ?? '',
            title: d.title,
            start: d.start_time,
            end: d.end_time,
            all_day: d.all_day,
            description: d.description ?? null,
            status: d.status ?? 'confirmed',
          }));

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ ticklers, total: ticklers.length }),
            }],
          };
        } catch (err) {
          logger.warn('[list_ticklers] ES read failed for ticklers, falling back to Google API', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Fallback: Google API
      const existing = await calendarConfigRepo.getByRole(userId, 'tickler');
      if (!existing) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ticklers: [], total: 0, message: 'No tickler calendar exists yet' }),
          }],
        };
      }

      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });

      const response = await calendarApi.events.list({
        calendarId: existing.calendar_id,
        timeMin, timeMax,
        maxResults: 100,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const ticklers = (response.data.items ?? []).map((event) => ({
        event_id: event.id ?? '',
        title: event.summary ?? '',
        start: event.start?.dateTime ?? event.start?.date ?? '',
        end: event.end?.dateTime ?? event.end?.date ?? '',
        all_day: !event.start?.dateTime,
        description: event.description ?? null,
        status: event.status ?? 'confirmed',
        recurring: !!event.recurringEventId,
        recurring_event_id: event.recurringEventId ?? null,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ticklers, total: ticklers.length }),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // complete_tickler
  // ---------------------------------------------------------------------------
  server.tool(
    'complete_tickler',
    'Mark a tickler as done. For one-off ticklers, deletes the event. For recurring ticklers, deletes only the specific instance (the series continues). Pass delete_series=true to stop the entire recurring series.',
    {
      event_id: z.string().describe('The event ID of the tickler to complete. For recurring tickler instances, use the instance ID (e.g. "abc123_20260403T050000Z") from list_ticklers.'),
      delete_series: z.boolean().optional().describe('If true and this is a recurring tickler instance, delete the entire series instead of just this instance. Default: false.'),
    },
    async ({ event_id, delete_series }) => {
      const userId = getUserId();
      const existing = await calendarConfigRepo.getByRole(userId, 'tickler');
      if (!existing) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No tickler calendar found' }),
          }],
        };
      }

      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });

      // Check if this is a recurring event instance
      let targetEventId = event_id;
      let deletedSeries = false;

      if (delete_series) {
        // Fetch the event to find the recurring event ID (the parent series)
        try {
          const event = await calendarApi.events.get({
            calendarId: existing.calendar_id,
            eventId: event_id,
          });
          if (event.data.recurringEventId) {
            targetEventId = event.data.recurringEventId;
            deletedSeries = true;
          }
        } catch (err) {
          logger.warn('[complete_tickler] Failed to look up recurring parent, deleting instance directly', { event_id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      await calendarApi.events.delete({
        calendarId: existing.calendar_id,
        eventId: targetEventId,
      });

      logAudit({ user_id: userId, source: 'calendar', action: 'complete', entity_type: 'tickler', entity_id: targetEventId, summary: `Completed tickler: ${targetEventId}${deletedSeries ? ' (entire series)' : ''}` });

      // Remove from ES
      if (esRepo) {
        if (deletedSeries) {
          // For series deletion, remove by the recurring event ID pattern
          // Individual instances have doc IDs like tickler-eventId_timestamp
          // The parent has doc ID tickler-eventId
          await esRepo.deleteByDocId(`tickler-${targetEventId}`);
        } else {
          await esRepo.deleteByDocId(`tickler-${event_id}`);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, event_id: targetEventId, deleted_series: deletedSeries }),
        }],
      };
    },
  );
}
