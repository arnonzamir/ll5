import { z } from 'zod';
import { google } from 'googleapis';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import type { CalendarConfigRepository, CalendarAccessMode } from '../repositories/interfaces/calendar-config.repository.js';
import type { UserSettingsRepository } from '../repositories/interfaces/user-settings.repository.js';
import { getAuthenticatedClient, type GoogleClientConfig } from '../utils/google-client.js';
import { logAudit } from '@ll5/shared';
import { logger } from '../utils/logger.js';

/** Get start-of-day in a given timezone as an ISO string. */
function getStartOfDay(tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateStr = fmt.format(new Date());
  return new Date(`${dateStr}T00:00:00`).toISOString();
}

/** Get end-of-day in a given timezone as an ISO string. */
function getEndOfDay(tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateStr = fmt.format(new Date());
  return new Date(`${dateStr}T23:59:59`).toISOString();
}

export function registerCalendarTools(
  server: McpServer,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
  userSettingsRepo: UserSettingsRepository,
  config: GoogleClientConfig,
  getUserId: () => string,
): void {

  // ---------------------------------------------------------------------------
  // list_calendars
  // ---------------------------------------------------------------------------
  server.tool(
    'list_calendars',
    'List Google Calendars accessible to the user, with access mode (ignore/read/readwrite). Use refresh=true to sync from Google.',
    {
      refresh: z.boolean().optional().describe('Force refresh from Google API (default: false)'),
    },
    async ({ refresh }) => {
      const userId = getUserId();

      if (!refresh) {
        const cached = await calendarConfigRepo.list(userId);
        if (cached.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(cached.map((c) => ({
                calendar_id: c.calendar_id,
                name: c.calendar_name,
                access_mode: c.access_mode,
                role: c.role,
                color: c.color,
              })), null, 2),
            }],
          };
        }
      }

      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendar = google.calendar({ version: 'v3', auth });
      const response = await calendar.calendarList.list();
      const items = response.data.items ?? [];

      const existingConfigs = await calendarConfigRepo.list(userId);
      const existingMap = new Map(existingConfigs.map((c) => [c.calendar_id, c]));

      const calendars = [];
      for (const item of items) {
        const calId = item.id ?? '';
        const calName = item.summary ?? '';
        const color = item.backgroundColor ?? '#4285f4';
        const existing = existingMap.get(calId);

        await calendarConfigRepo.upsert(userId, {
          calendar_id: calId,
          calendar_name: calName,
          color,
        });

        calendars.push({
          calendar_id: calId,
          name: calName,
          access_mode: existing?.access_mode ?? 'read',
          role: existing?.role ?? 'user',
          color,
          google_access_role: item.accessRole ?? 'reader',
          primary: item.primary ?? false,
        });
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
  // configure_calendar
  // ---------------------------------------------------------------------------
  server.tool(
    'configure_calendar',
    'Set the access mode for a Google Calendar. Use "ignore" to hide it, "read" for read-only, "readwrite" for full access.',
    {
      calendar_id: z.string().describe('Google Calendar ID'),
      access_mode: z.enum(['ignore', 'read', 'readwrite']).describe('Access mode'),
    },
    async ({ calendar_id, access_mode }) => {
      const userId = getUserId();
      await calendarConfigRepo.setAccessMode(userId, calendar_id, access_mode as CalendarAccessMode);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ calendar_id, access_mode, updated: true }),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // set_timezone
  // ---------------------------------------------------------------------------
  server.tool(
    'set_timezone',
    'Set the user timezone for calendar queries. Affects what "today" means.',
    {
      timezone: z.string().describe('IANA timezone (e.g., "Asia/Jerusalem", "America/New_York")'),
    },
    async ({ timezone }) => {
      const userId = getUserId();
      // Validate timezone
      try {
        Intl.DateTimeFormat('en-US', { timeZone: timezone });
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Invalid timezone: ${timezone}` }),
          }],
        };
      }
      await userSettingsRepo.setTimezone(userId, timezone);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ timezone, updated: true }),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_events
  // ---------------------------------------------------------------------------
  server.tool(
    'list_events',
    'List Google Calendar events within a date range. Queries all readable calendars. FreeBusyReader calendars return busy blocks labeled "Busy (calendar name)".',
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
      const settings = await userSettingsRepo.get(userId);

      const timeMin = from ?? getStartOfDay(settings.timezone);
      const timeMax = to ?? getEndOfDay(settings.timezone);
      const maxResults = max_results ?? 50;
      const includeAllDay = include_all_day !== false;

      // Determine which calendars to query
      let calendarIds: string[];
      if (calendar_id) {
        calendarIds = [calendar_id];
      } else {
        calendarIds = await calendarConfigRepo.getReadableCalendarIds(userId);
        if (calendarIds.length === 0) {
          calendarIds = ['primary'];
        }
      }

      // Fetch local config to know names and google access roles
      const localConfigs = await calendarConfigRepo.list(userId);
      const configMap = new Map(localConfigs.map((c) => [c.calendar_id, c]));

      const allEvents: Record<string, unknown>[] = [];
      const freeBusyCalendars: string[] = [];

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

          const calConfig = configMap.get(calId);
          const items = response.data.items ?? [];
          for (const event of items) {
            const isAllDay = !event.start?.dateTime;
            if (!includeAllDay && isAllDay) continue;

            allEvents.push({
              event_id: event.id ?? '',
              calendar_id: calId,
              calendar_name: calConfig?.calendar_name ?? calId,
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
        } catch {
          // events.list failed — likely a freeBusyReader calendar
          freeBusyCalendars.push(calId);
        }
      }

      // Query freeBusy for calendars that failed events.list
      if (freeBusyCalendars.length > 0) {
        try {
          const fbResponse = await calendarApi.freebusy.query({
            requestBody: {
              timeMin,
              timeMax,
              items: freeBusyCalendars.map((id) => ({ id })),
            },
          });

          const fbCalendars = fbResponse.data.calendars ?? {};
          for (const [calId, calData] of Object.entries(fbCalendars)) {
            const calConfig = configMap.get(calId);
            const calName = calConfig?.calendar_name ?? calId;
            const busySlots = calData.busy ?? [];

            for (const slot of busySlots) {
              allEvents.push({
                event_id: `freebusy-${calId}-${slot.start}`,
                calendar_id: calId,
                calendar_name: calName,
                title: `Busy (${calName})`,
                start: slot.start ?? '',
                end: slot.end ?? '',
                all_day: false,
                location: null,
                description: null,
                attendees: [],
                html_link: '',
                status: 'confirmed',
                recurring: false,
                is_free_busy: true,
              });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('FreeBusy query failed', { error: message, calendars: freeBusyCalendars });
        }
      }

      // Sort by start time
      allEvents.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
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
    'Create a new event on a Google Calendar. Only works on calendars with readwrite access.',
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

      if (calId !== 'primary') {
        const writable = await calendarConfigRepo.getWritableCalendarIds(userId);
        if (!writable.includes(calId)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Calendar ${calId} is not configured for readwrite access. Use configure_calendar to change.`,
              }),
            }],
          };
        }
      }

      const isAllDay = all_day === true;
      const settings = await userSettingsRepo.get(userId);

      const eventBody: Record<string, unknown> = {
        summary: title,
        description: description ?? undefined,
        location: location ?? undefined,
      };

      if (isAllDay) {
        eventBody.start = { date: start };
        eventBody.end = { date: end };
      } else {
        eventBody.start = { dateTime: start, timeZone: settings.timezone };
        eventBody.end = { dateTime: end, timeZone: settings.timezone };
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

      logAudit({ user_id: userId, source: 'google', action: 'create', entity_type: 'event', entity_id: response.data.id ?? '', summary: `Created event: ${title}` });

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

  // ---------------------------------------------------------------------------
  // update_event
  // ---------------------------------------------------------------------------
  server.tool(
    'update_event',
    'Update an existing Google Calendar event. Only works on calendars with readwrite access. Only provided fields are changed.',
    {
      event_id: z.string().describe('Google event ID to update'),
      calendar_id: z.string().optional().describe('Calendar ID the event belongs to (default: primary)'),
      title: z.string().optional().describe('New event title'),
      start: z.string().optional().describe('New start time (ISO 8601)'),
      end: z.string().optional().describe('New end time (ISO 8601)'),
      description: z.string().optional().describe('New description'),
      location: z.string().optional().describe('New location'),
      attendees: z.array(z.string()).optional().describe('Replace attendee list (email addresses)'),
      all_day: z.boolean().optional().describe('Convert to/from all-day event'),
    },
    async ({ event_id, calendar_id, title, start, end, description, location, attendees, all_day }) => {
      const userId = getUserId();
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });
      const settings = await userSettingsRepo.get(userId);

      const calId = calendar_id ?? 'primary';

      if (calId !== 'primary') {
        const writable = await calendarConfigRepo.getWritableCalendarIds(userId);
        if (!writable.includes(calId)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Calendar ${calId} is not configured for readwrite access.` }),
            }],
          };
        }
      }

      // Fetch current event to merge with updates
      const current = await calendarApi.events.get({ calendarId: calId, eventId: event_id });
      const patch: Record<string, unknown> = {};

      if (title !== undefined) patch.summary = title;
      if (description !== undefined) patch.description = description;
      if (location !== undefined) patch.location = location;

      if (attendees !== undefined) {
        patch.attendees = attendees.map((email) => ({ email }));
      }

      const isAllDay = all_day ?? !current.data.start?.dateTime;

      if (start !== undefined || all_day !== undefined) {
        if (isAllDay) {
          patch.start = { date: start ?? current.data.start?.date };
        } else {
          patch.start = { dateTime: start ?? current.data.start?.dateTime, timeZone: settings.timezone };
        }
      }

      if (end !== undefined || all_day !== undefined) {
        if (isAllDay) {
          patch.end = { date: end ?? current.data.end?.date };
        } else {
          patch.end = { dateTime: end ?? current.data.end?.dateTime, timeZone: settings.timezone };
        }
      }

      const response = await calendarApi.events.patch({
        calendarId: calId,
        eventId: event_id,
        requestBody: patch as Parameters<typeof calendarApi.events.patch>[0] extends { requestBody?: infer R } ? R : never,
      });

      logAudit({ user_id: userId, source: 'google', action: 'update', entity_type: 'event', entity_id: event_id, summary: `Updated event: ${response.data.summary ?? event_id}`, metadata: patch });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            event_id: response.data.id ?? '',
            html_link: response.data.htmlLink ?? '',
            status: response.data.status ?? 'confirmed',
            updated: true,
          }, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // delete_event
  // ---------------------------------------------------------------------------
  server.tool(
    'delete_event',
    'Delete a Google Calendar event. Only works on calendars with readwrite access.',
    {
      event_id: z.string().describe('Google event ID to delete'),
      calendar_id: z.string().optional().describe('Calendar ID the event belongs to (default: primary)'),
    },
    async ({ event_id, calendar_id }) => {
      const userId = getUserId();
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });

      const calId = calendar_id ?? 'primary';

      if (calId !== 'primary') {
        const writable = await calendarConfigRepo.getWritableCalendarIds(userId);
        if (!writable.includes(calId)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Calendar ${calId} is not configured for readwrite access.` }),
            }],
          };
        }
      }

      await calendarApi.events.delete({ calendarId: calId, eventId: event_id });

      logAudit({ user_id: userId, source: 'google', action: 'delete', entity_type: 'event', entity_id: event_id, summary: `Deleted event: ${event_id}` });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ event_id, deleted: true }),
        }],
      };
    },
  );
}
