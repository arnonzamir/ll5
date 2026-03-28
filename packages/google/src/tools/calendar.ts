import { z } from 'zod';
import { google } from 'googleapis';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import type { CalendarConfigRepository } from '../repositories/interfaces/calendar-config.repository.js';
import { getAuthenticatedClient, type GoogleClientConfig } from '../utils/google-client.js';
import { logger } from '../utils/logger.js';

export function registerCalendarTools(
  server: McpServer,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
  config: GoogleClientConfig,
  getUserId: () => string,
): void {

  // ---------------------------------------------------------------------------
  // list_calendars
  // ---------------------------------------------------------------------------
  server.tool(
    'list_calendars',
    'List Google Calendars accessible to the user, including enable/disable status. Syncs from Google and merges with local config.',
    {
      refresh: z.boolean().optional().describe('Force refresh from Google API (default: false)'),
    },
    async ({ refresh }) => {
      const userId = getUserId();

      // If not refreshing, return cached config
      if (!refresh) {
        const cached = await calendarConfigRepo.list(userId);
        if (cached.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(cached.map((c) => ({
                calendar_id: c.calendar_id,
                name: c.calendar_name,
                enabled: c.enabled,
                color: c.color,
                access_role: 'unknown',
                primary: false,
              })), null, 2),
            }],
          };
        }
      }

      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendar = google.calendar({ version: 'v3', auth });
      const response = await calendar.calendarList.list();
      const items = response.data.items ?? [];

      const calendars = [];
      for (const item of items) {
        const calId = item.id ?? '';
        const calName = item.summary ?? '';
        const color = item.backgroundColor ?? '#4285f4';

        // Upsert into local config
        await calendarConfigRepo.upsert(userId, {
          calendar_id: calId,
          calendar_name: calName,
          color,
        });

        calendars.push({
          calendar_id: calId,
          name: calName,
          enabled: true, // Will be overridden below
          color,
          access_role: item.accessRole ?? 'reader',
          primary: item.primary ?? false,
        });
      }

      // Merge with local enabled/disabled state
      const localConfigs = await calendarConfigRepo.list(userId);
      const localMap = new Map(localConfigs.map((c) => [c.calendar_id, c]));
      for (const cal of calendars) {
        const local = localMap.get(cal.calendar_id);
        if (local) {
          cal.enabled = local.enabled;
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(calendars, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_events
  // ---------------------------------------------------------------------------
  server.tool(
    'list_events',
    'List Google Calendar events within a date range. Merges all enabled calendars or filters to a specific one.',
    {
      from: z.string().optional().describe('Start of date range (ISO 8601). Default: start of today.'),
      to: z.string().optional().describe('End of date range (ISO 8601). Default: end of today.'),
      calendar_id: z.string().optional().describe('Filter to a specific calendar ID'),
      query: z.string().optional().describe('Free-text search query for event title/description'),
      max_results: z.number().optional().describe('Max events to return (default: 50)'),
      include_all_day: z.boolean().optional().describe('Include all-day events (default: true)'),
    },
    async ({ from, to, calendar_id, query, max_results, include_all_day }) => {
      const userId = getUserId();
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

      const timeMin = from ?? startOfDay.toISOString();
      const timeMax = to ?? endOfDay.toISOString();
      const maxResults = max_results ?? 50;
      const includeAllDay = include_all_day !== false;

      // Determine which calendars to query
      let calendarIds: string[];
      if (calendar_id) {
        calendarIds = [calendar_id];
      } else {
        calendarIds = await calendarConfigRepo.getEnabledCalendarIds(userId);
        if (calendarIds.length === 0) {
          calendarIds = ['primary'];
        }
      }

      // Fetch local config for calendar names
      const localConfigs = await calendarConfigRepo.list(userId);
      const nameMap = new Map(localConfigs.map((c) => [c.calendar_id, c.calendar_name]));

      const allEvents: Record<string, unknown>[] = [];

      for (const calId of calendarIds) {
        try {
          const response = await calendarApi.events.list({
            calendarId: calId,
            timeMin,
            timeMax,
            maxResults,
            singleEvents: true,
            orderBy: 'startTime',
            q: query ?? undefined,
          });

          const items = response.data.items ?? [];
          for (const event of items) {
            const isAllDay = !event.start?.dateTime;
            if (!includeAllDay && isAllDay) continue;

            allEvents.push({
              event_id: event.id ?? '',
              calendar_id: calId,
              calendar_name: nameMap.get(calId) ?? calId,
              title: event.summary ?? '(no title)',
              start: event.start?.dateTime ?? event.start?.date ?? '',
              end: event.end?.dateTime ?? event.end?.date ?? '',
              all_day: isAllDay,
              location: event.location ?? null,
              description: event.description ?? null,
              attendees: (event.attendees ?? []).map((a) => ({
                email: a.email ?? '',
                name: a.displayName ?? null,
                response_status: a.responseStatus ?? 'needsAction',
              })),
              html_link: event.htmlLink ?? '',
              status: event.status ?? 'confirmed',
              recurring: !!event.recurringEventId,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to fetch events from calendar ${calId}`, { error: message });
        }
      }

      // Sort merged events by start time
      allEvents.sort((a, b) => {
        const aStart = String(a.start ?? '');
        const bStart = String(b.start ?? '');
        return aStart.localeCompare(bStart);
      });

      // Trim to max results
      const trimmed = allEvents.slice(0, maxResults);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(trimmed, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // create_event
  // ---------------------------------------------------------------------------
  server.tool(
    'create_event',
    'Create a new event on a Google Calendar.',
    {
      calendar_id: z.string().optional().describe('Target calendar ID (default: primary)'),
      title: z.string().describe('Event title'),
      start: z.string().describe('Event start time (ISO 8601)'),
      end: z.string().describe('Event end time (ISO 8601)'),
      description: z.string().optional().describe('Event description'),
      location: z.string().optional().describe('Event location'),
      attendees: z.array(z.string()).optional().describe('List of attendee email addresses'),
      all_day: z.boolean().optional().describe('Create as all-day event. When true, start/end should be YYYY-MM-DD.'),
      reminders: z.object({
        use_default: z.boolean(),
        overrides: z.array(z.object({
          method: z.enum(['email', 'popup']),
          minutes: z.number(),
        })).optional(),
      }).optional().describe('Reminder settings'),
    },
    async ({ calendar_id, title, start, end, description, location, attendees, all_day, reminders }) => {
      const userId = getUserId();
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });

      const calId = calendar_id ?? 'primary';
      const isAllDay = all_day === true;

      const eventBody: Record<string, unknown> = {
        summary: title,
        description: description ?? undefined,
        location: location ?? undefined,
      };

      if (isAllDay) {
        eventBody.start = { date: start };
        eventBody.end = { date: end };
      } else {
        eventBody.start = { dateTime: start };
        eventBody.end = { dateTime: end };
      }

      if (attendees && attendees.length > 0) {
        eventBody.attendees = attendees.map((email) => ({ email }));
      }

      if (reminders) {
        eventBody.reminders = {
          useDefault: reminders.use_default,
          overrides: reminders.overrides?.map((o) => ({
            method: o.method,
            minutes: o.minutes,
          })),
        };
      }

      const response = await calendarApi.events.insert({
        calendarId: calId,
        requestBody: eventBody as Parameters<typeof calendarApi.events.insert>[0] extends { requestBody?: infer R } ? R : never,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            event_id: response.data.id ?? '',
            html_link: response.data.htmlLink ?? '',
            status: response.data.status ?? 'confirmed',
          }, null, 2),
        }],
      };
    },
  );
}
