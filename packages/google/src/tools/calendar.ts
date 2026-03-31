import { z } from 'zod';
import { google } from 'googleapis';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import type { CalendarConfigRepository, CalendarAccessMode } from '../repositories/interfaces/calendar-config.repository.js';
import type { UserSettingsRepository } from '../repositories/interfaces/user-settings.repository.js';
import type { ESCalendarEventRepository } from '../repositories/elasticsearch/calendar-event.repository.js';
import { getAuthenticatedClient, type GoogleClientConfig } from '../utils/google-client.js';
import { logAudit, generateToken } from '@ll5/shared';
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

/**
 * Fetch events from Google API for a set of calendars.
 * Used for sync and as a fallback when ES is unavailable.
 */
async function fetchEventsFromGoogle(
  config: GoogleClientConfig,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
  userId: string,
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  query?: string,
  maxResults: number = 100,
): Promise<Record<string, unknown>[]> {
  const auth = await getAuthenticatedClient(config, tokenRepo, userId);
  const calendarApi = google.calendar({ version: 'v3', auth });
  const localConfigs = await calendarConfigRepo.list(userId);
  const configMap = new Map(localConfigs.map((c) => [c.calendar_id, c]));

  const allEvents: Record<string, unknown>[] = [];
  const freeBusyCalendars: string[] = [];

  for (const calId of calendarIds) {
    try {
      const response = await calendarApi.events.list({
        calendarId: calId,
        timeMin, timeMax, maxResults,
        singleEvents: true,
        orderBy: 'startTime',
        q: query ?? undefined,
      });

      const calConfig = configMap.get(calId);
      for (const event of response.data.items ?? []) {
        allEvents.push({
          event_id: event.id ?? '',
          calendar_id: calId,
          calendar_name: calConfig?.calendar_name ?? calId,
          calendar_color: calConfig?.color ?? '#4285f4',
          title: event.summary ?? '(no title)',
          start: event.start?.dateTime ?? event.start?.date ?? '',
          end: event.end?.dateTime ?? event.end?.date ?? '',
          all_day: !event.start?.dateTime,
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
          is_free_busy: false,
        });
      }
    } catch {
      freeBusyCalendars.push(calId);
    }
  }

  // FreeBusy fallback
  if (freeBusyCalendars.length > 0) {
    try {
      const auth2 = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi2 = google.calendar({ version: 'v3', auth: auth2 });
      const fbResponse = await calendarApi2.freebusy.query({
        requestBody: {
          timeMin, timeMax,
          items: freeBusyCalendars.map((id) => ({ id })),
        },
      });
      for (const [calId, calData] of Object.entries(fbResponse.data.calendars ?? {})) {
        const calConfig = configMap.get(calId);
        const calName = calConfig?.calendar_name ?? calId;
        for (const slot of calData.busy ?? []) {
          allEvents.push({
            event_id: `freebusy-${calId}-${slot.start}`,
            calendar_id: calId,
            calendar_name: calName,
            calendar_color: calConfig?.color ?? '#4285f4',
            title: `Busy (${calName})`,
            start: slot.start ?? '', end: slot.end ?? '',
            all_day: false, location: null, description: null,
            attendees: [], html_link: '', status: 'confirmed',
            recurring: false, is_free_busy: true,
          });
        }
      }
    } catch (err) {
      logger.warn('[fetchEventsFromGoogle] FreeBusy query failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  allEvents.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
  return allEvents;
}

export function registerCalendarTools(
  server: McpServer,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
  userSettingsRepo: UserSettingsRepository,
  esRepo: ESCalendarEventRepository | null,
  config: GoogleClientConfig,
  getUserId: () => string,
): void {

  // ---------------------------------------------------------------------------
  // list_calendars
  // ---------------------------------------------------------------------------
  server.tool(
    'list_calendars',
    'List calendars with access mode (ignore/read/readwrite). Use refresh=true to sync from Google.',
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
          calendar_id: calId, calendar_name: calName, color,
        });

        calendars.push({
          calendar_id: calId, name: calName,
          access_mode: existing?.access_mode ?? 'read',
          role: existing?.role ?? 'user', color,
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
    'Set the access mode for a calendar: ignore (hidden), read (read-only), readwrite (full access).',
    {
      calendar_id: z.string().describe('Calendar ID'),
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
    'Set the user timezone for calendar queries.',
    {
      timezone: z.string().describe('IANA timezone (e.g., "Asia/Jerusalem")'),
    },
    async ({ timezone }) => {
      const userId = getUserId();
      try {
        Intl.DateTimeFormat('en-US', { timeZone: timezone });
      } catch {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid timezone: ${timezone}` }) }],
        };
      }
      await userSettingsRepo.setTimezone(userId, timezone);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ timezone, updated: true }) }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_events — reads from ES (unified view), falls back to Google API
  // ---------------------------------------------------------------------------
  server.tool(
    'list_events',
    'List calendar events from the unified timeline. Aggregates all sources: Google Calendar, phone-pushed events (which may have richer details than Google for some calendars), and ticklers. Results include a "source" field showing where each event came from. Use refresh=true to force a fresh sync from Google.',
    {
      from: z.string().optional().describe('Start of range (ISO 8601). Default: start of today.'),
      to: z.string().optional().describe('End of range (ISO 8601). Default: end of today.'),
      calendar_id: z.string().optional().describe('Filter to a specific calendar ID'),
      query: z.string().optional().describe('Free-text search'),
      max_results: z.number().optional().describe('Max events (default: 50)'),
      include_all_day: z.boolean().optional().describe('Include all-day events (default: true)'),
      refresh: z.boolean().optional().describe('Sync from Google before reading (default: false)'),
    },
    async ({ from, to, calendar_id, query, max_results, include_all_day, refresh }) => {
      const userId = getUserId();
      const settings = await userSettingsRepo.get(userId);
      const timeMin = from ?? getStartOfDay(settings.timezone);
      const timeMax = to ?? getEndOfDay(settings.timezone);
      const maxResults = max_results ?? 50;

      // Determine readable calendars
      let calendarIds: string[];
      if (calendar_id) {
        calendarIds = [calendar_id];
      } else {
        calendarIds = await calendarConfigRepo.getReadableCalendarIds(userId);
        if (calendarIds.length === 0) calendarIds = ['primary'];
      }

      // On-demand sync if requested
      if (refresh) {
        try {
          const events = await fetchEventsFromGoogle(
            config, tokenRepo, calendarConfigRepo, userId,
            calendarIds, timeMin, timeMax, undefined, 200,
          );
          if (esRepo) {
            const localConfigs = await calendarConfigRepo.list(userId);
            const configMap = new Map(localConfigs.map((c) => [c.calendar_id, c]));
            for (const event of events) {
              const calConfig = configMap.get(String(event.calendar_id));
              const isTickler = calConfig?.role === 'tickler';
              await esRepo.upsertFromGoogle(userId, event as Parameters<typeof esRepo.upsertFromGoogle>[1], isTickler);
            }
          }
        } catch (err) {
          logger.warn('[list_events] On-demand sync failed, reading from cache', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Read from ES if available
      if (esRepo) {
        try {
          const docs = await esRepo.query(userId, {
            from: timeMin, to: timeMax,
            calendarIds: calendar_id ? [calendar_id] : calendarIds,
            isTickler: false,
            query, includeAllDay: include_all_day,
            limit: maxResults,
          });

          const events = docs.map((d) => ({
            event_id: d.google_event_id ?? '',
            calendar_id: d.calendar_id ?? '',
            calendar_name: d.calendar_name ?? '',
            calendar_color: d.calendar_color ?? '#4285f4',
            title: d.title,
            start: d.start_time,
            end: d.end_time,
            all_day: d.all_day,
            location: d.location ?? null,
            description: d.description ?? null,
            attendees: d.attendees_detail ?? [],
            html_link: d.html_link ?? '',
            status: d.status ?? 'confirmed',
            recurring: d.recurring ?? false,
            is_free_busy: d.is_free_busy ?? false,
            source: d.source,
          }));

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(events, null, 2),
            }],
          };
        } catch (err) {
          logger.warn('[list_events] ES read failed, falling back to Google API', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Fallback: live Google API
      const events = await fetchEventsFromGoogle(
        config, tokenRepo, calendarConfigRepo, userId,
        calendarIds, timeMin, timeMax, query, maxResults,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(events.slice(0, maxResults), null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // create_event — writes to Google API + ES
  // ---------------------------------------------------------------------------
  server.tool(
    'create_event',
    'Create a calendar event. Writes to the calendar and immediately updates the unified timeline. Only works on calendars with readwrite access.',
    {
      calendar_id: z.string().optional().describe('Target calendar ID (default: primary)'),
      title: z.string().describe('Event title'),
      start: z.string().describe('Start time (ISO 8601)'),
      end: z.string().describe('End time (ISO 8601)'),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
      all_day: z.boolean().optional().describe('All-day event (start/end should be YYYY-MM-DD)'),
      reminders: z.object({
        use_default: z.boolean(),
        overrides: z.array(z.object({
          method: z.enum(['email', 'popup']),
          minutes: z.number(),
        })).optional(),
      }).optional(),
    },
    async ({ calendar_id, title, start, end, description, location, attendees, all_day, reminders }) => {
      const userId = getUserId();
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });
      const settings = await userSettingsRepo.get(userId);
      const calId = calendar_id ?? 'primary';

      if (calId !== 'primary') {
        const writable = await calendarConfigRepo.getWritableCalendarIds(userId);
        if (!writable.includes(calId)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Calendar ${calId} not configured for readwrite.` }) }],
          };
        }
      }

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
        eventBody.start = { dateTime: start, timeZone: settings.timezone };
        eventBody.end = { dateTime: end, timeZone: settings.timezone };
      }

      if (attendees?.length) eventBody.attendees = attendees.map((email) => ({ email }));
      if (reminders) {
        eventBody.reminders = {
          useDefault: reminders.use_default,
          overrides: reminders.overrides?.map((o) => ({ method: o.method, minutes: o.minutes })),
        };
      }

      const response = await calendarApi.events.insert({
        calendarId: calId,
        requestBody: eventBody as Parameters<typeof calendarApi.events.insert>[0] extends { requestBody?: infer R } ? R : never,
      });

      const eventId = response.data.id ?? '';
      logAudit({ user_id: userId, source: 'calendar', action: 'create', entity_type: 'event', entity_id: eventId, summary: `Created event: ${title}` });

      // Write-through to ES
      if (esRepo) {
        const localConfigs = await calendarConfigRepo.list(userId);
        const calConfig = localConfigs.find((c) => c.calendar_id === calId);
        await esRepo.upsertFromGoogle(userId, {
          event_id: eventId,
          calendar_id: calId,
          calendar_name: calConfig?.calendar_name ?? calId,
          calendar_color: calConfig?.color,
          title,
          start: response.data.start?.dateTime ?? response.data.start?.date ?? start,
          end: response.data.end?.dateTime ?? response.data.end?.date ?? end,
          all_day: isAllDay,
          location, description,
          attendees: attendees?.map((e) => ({ email: e })),
          html_link: response.data.htmlLink ?? undefined,
          status: response.data.status ?? 'confirmed',
          recurring: false,
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ event_id: eventId, html_link: response.data.htmlLink ?? '', status: response.data.status ?? 'confirmed' }, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // update_event — writes to Google API + ES
  // ---------------------------------------------------------------------------
  server.tool(
    'update_event',
    'Update a calendar event. Only provided fields are changed. Writes to the calendar and immediately updates the unified timeline.',
    {
      event_id: z.string().describe('Event ID to update'),
      calendar_id: z.string().optional().describe('Calendar ID (default: primary)'),
      title: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      all_day: z.boolean().optional(),
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
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Calendar ${calId} not configured for readwrite.` }) }],
          };
        }
      }

      const current = await calendarApi.events.get({ calendarId: calId, eventId: event_id });
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.summary = title;
      if (description !== undefined) patch.description = description;
      if (location !== undefined) patch.location = location;
      if (attendees !== undefined) patch.attendees = attendees.map((email) => ({ email }));

      const isAllDay = all_day ?? !current.data.start?.dateTime;
      if (start !== undefined || all_day !== undefined) {
        patch.start = isAllDay ? { date: start ?? current.data.start?.date } : { dateTime: start ?? current.data.start?.dateTime, timeZone: settings.timezone };
      }
      if (end !== undefined || all_day !== undefined) {
        patch.end = isAllDay ? { date: end ?? current.data.end?.date } : { dateTime: end ?? current.data.end?.dateTime, timeZone: settings.timezone };
      }

      const response = await calendarApi.events.patch({
        calendarId: calId, eventId: event_id,
        requestBody: patch as Parameters<typeof calendarApi.events.patch>[0] extends { requestBody?: infer R } ? R : never,
      });

      logAudit({ user_id: userId, source: 'calendar', action: 'update', entity_type: 'event', entity_id: event_id, summary: `Updated event: ${response.data.summary ?? event_id}`, metadata: patch });

      // Write-through to ES
      if (esRepo) {
        const localConfigs = await calendarConfigRepo.list(userId);
        const calConfig = localConfigs.find((c) => c.calendar_id === calId);
        await esRepo.upsertFromGoogle(userId, {
          event_id,
          calendar_id: calId,
          calendar_name: calConfig?.calendar_name ?? calId,
          calendar_color: calConfig?.color,
          title: response.data.summary ?? '(no title)',
          start: response.data.start?.dateTime ?? response.data.start?.date ?? '',
          end: response.data.end?.dateTime ?? response.data.end?.date ?? '',
          all_day: !response.data.start?.dateTime,
          location: response.data.location,
          description: response.data.description,
          attendees: (response.data.attendees ?? []).map((a) => ({ email: a.email ?? '', name: a.displayName ?? null, response_status: a.responseStatus ?? undefined })),
          html_link: response.data.htmlLink ?? undefined,
          status: response.data.status ?? 'confirmed',
          recurring: !!response.data.recurringEventId,
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ event_id, html_link: response.data.htmlLink ?? '', status: response.data.status ?? 'confirmed', updated: true }, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // delete_event — deletes from Google API + ES
  // ---------------------------------------------------------------------------
  server.tool(
    'delete_event',
    'Delete a calendar event from both the calendar and the unified timeline. Only works on calendars with readwrite access.',
    {
      event_id: z.string().describe('Event ID to delete'),
      calendar_id: z.string().optional().describe('Calendar ID (default: primary)'),
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
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Calendar ${calId} not configured for readwrite.` }) }],
          };
        }
      }

      await calendarApi.events.delete({ calendarId: calId, eventId: event_id });
      logAudit({ user_id: userId, source: 'calendar', action: 'delete', entity_type: 'event', entity_id: event_id, summary: `Deleted event: ${event_id}` });

      // Remove from ES
      if (esRepo) {
        await esRepo.deleteByDocId(`google-${event_id}`);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ event_id, deleted: true }) }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // sync_calendar — on-demand Google → ES sync
  // ---------------------------------------------------------------------------
  server.tool(
    'sync_calendar',
    'Sync calendar events from Google to the unified timeline. The gateway also syncs automatically every 30 minutes and phone pushes arrive in real-time. Use this for a manual full refresh.',
    {
      from: z.string().optional().describe('Start of sync window (ISO 8601). Default: 7 days ago.'),
      to: z.string().optional().describe('End of sync window (ISO 8601). Default: 30 days from now.'),
    },
    async ({ from, to }) => {
      const userId = getUserId();

      if (!esRepo) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ES not configured' }) }],
        };
      }

      const now = new Date();
      const timeMin = from ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const timeMax = to ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const calendarIds = await calendarConfigRepo.getReadableCalendarIds(userId);
      if (calendarIds.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ synced: 0, message: 'No readable calendars configured' }) }],
        };
      }

      const events = await fetchEventsFromGoogle(
        config, tokenRepo, calendarConfigRepo, userId,
        calendarIds, timeMin, timeMax, undefined, 500,
      );

      const localConfigs = await calendarConfigRepo.list(userId);
      const configMap = new Map(localConfigs.map((c) => [c.calendar_id, c]));

      let synced = 0;
      for (const event of events) {
        const calConfig = configMap.get(String(event.calendar_id));
        const isTickler = calConfig?.role === 'tickler';
        await esRepo.upsertFromGoogle(userId, event as Parameters<typeof esRepo.upsertFromGoogle>[1], isTickler);
        synced++;
      }

      logAudit({ user_id: userId, source: 'calendar', action: 'sync', entity_type: 'calendar', entity_id: 'all', summary: `Synced ${synced} events from Google Calendar` });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ synced, from: timeMin, to: timeMax }) }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // check_availability — query free/busy for people or calendars
  // ---------------------------------------------------------------------------
  server.tool(
    'check_availability',
    'Check availability (free/busy) for people or calendars. Three paths: (1) google — FreeBusy API via this server\'s OAuth (works if target shares free/busy). (2) device — queries phone\'s CalendarProvider for locally synced calendars. (3) device_freebusy — calls Google FreeBusy API using a phone account\'s OAuth token (works for same-Workspace-domain coworkers). Auto mode tries google first, falls back to device_freebusy if errors.',
    {
      emails: z.array(z.string()).optional().describe('Email addresses of people to check'),
      calendar_ids: z.array(z.string()).optional().describe('Calendar IDs to check'),
      accounts: z.array(z.string()).optional().describe('Account emails synced on the phone (for local calendar query)'),
      via_account: z.string().optional().describe('Phone Google account to use for FreeBusy API (e.g. "arnon@sunbit.com"). Required for device_freebusy mode.'),
      from: z.string().describe('Start of time range (ISO 8601)'),
      to: z.string().describe('End of time range (ISO 8601)'),
      include_own: z.boolean().optional().describe('Include your own primary calendar for comparison (default: true)'),
      source: z.enum(['google', 'device', 'device_freebusy', 'auto']).optional().describe('google = server FreeBusy API, device = phone CalendarProvider, device_freebusy = phone Google FreeBusy via AccountManager, auto = try google then device_freebusy. Default: auto'),
    },
    async ({ emails, calendar_ids, accounts, via_account, from, to, include_own, source }) => {
      const userId = getUserId();
      const mode = source ?? 'auto';

      // Google FreeBusy path
      const tryGoogle = async (): Promise<{ results: Record<string, { busy: { start: string; end: string }[]; errors?: string[] }>; hasErrors: boolean }> => {
        const items: { id: string }[] = [];
        if (emails?.length) {
          for (const email of emails) items.push({ id: email });
        }
        if (calendar_ids?.length) {
          for (const calId of calendar_ids) items.push({ id: calId });
        }
        if (include_own !== false) {
          items.push({ id: 'primary' });
        }

        if (items.length === 0) return { results: {}, hasErrors: false };

        const auth = await getAuthenticatedClient(config, tokenRepo, userId);
        const calendarApi = google.calendar({ version: 'v3', auth });

        const response = await calendarApi.freebusy.query({
          requestBody: { timeMin: from, timeMax: to, items },
        });

        const results: Record<string, { busy: { start: string; end: string }[]; errors?: string[] }> = {};
        let hasErrors = false;

        for (const [calId, calData] of Object.entries(response.data.calendars ?? {})) {
          const label = calId === 'primary' ? 'you' : calId;
          results[label] = {
            busy: (calData.busy ?? []).map((slot) => ({
              start: slot.start ?? '',
              end: slot.end ?? '',
            })),
          };
          if (calData.errors?.length) {
            results[label].errors = calData.errors.map((e) => e.reason ?? 'unknown');
            hasErrors = true;
          }
        }

        return { results, hasErrors };
      };

      // Helper: call gateway /availability/check
      const callGateway = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const gatewayUrl = process.env.GATEWAY_URL ?? 'http://gateway-xkkcc0g4o48kkcows8488so4:3000';
        const authSecret = process.env.AUTH_SECRET ?? '';
        if (!authSecret) return { error: 'AUTH_SECRET not configured' };
        const gwToken = generateToken(userId, authSecret, 1, 'user');

        const response = await fetch(`${gatewayUrl}/availability/check`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${gwToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, from, to }),
        });

        if (!response.ok) {
          const text = await response.text();
          return { error: `Device check failed: ${response.status} ${text}` };
        }
        return await response.json() as Record<string, unknown>;
      };

      // Device local path — query CalendarProvider for synced calendars
      const tryDeviceLocal = async (): Promise<Record<string, unknown>> => {
        const deviceAccounts = accounts ?? emails ?? [];
        if (deviceAccounts.length === 0) return { error: 'No accounts specified' };
        return callGateway({ accounts: deviceAccounts });
      };

      // Device FreeBusy path — use phone's Google account to call FreeBusy API
      const tryDeviceFreeBusy = async (checkEmailList?: string[]): Promise<Record<string, unknown>> => {
        const targetEmails = checkEmailList ?? emails ?? [];
        const account = via_account ?? '';
        if (targetEmails.length === 0) return { error: 'No emails specified' };
        if (!account) return { error: 'via_account required for device_freebusy' };
        return callGateway({ check_emails: targetEmails, via_account: account });
      };

      try {
        if (mode === 'device') {
          const result = await tryDeviceLocal();
          return { content: [{ type: 'text' as const, text: JSON.stringify({ source: 'device', ...result }, null, 2) }] };
        }

        if (mode === 'device_freebusy') {
          const result = await tryDeviceFreeBusy();
          return { content: [{ type: 'text' as const, text: JSON.stringify({ source: 'device_freebusy', ...result }, null, 2) }] };
        }

        if (mode === 'google') {
          const { results } = await tryGoogle();
          return { content: [{ type: 'text' as const, text: JSON.stringify({ source: 'google', ...results }, null, 2) }] };
        }

        // auto: try Google first, fall back to device_freebusy for errored accounts
        const { results, hasErrors } = await tryGoogle();

        if (!hasErrors) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ source: 'google', ...results }, null, 2) }] };
        }

        // Collect emails that had errors from Google
        const erroredEmails = Object.entries(results)
          .filter(([, v]) => v.errors?.length)
          .map(([email]) => email);

        if (erroredEmails.length > 0 && via_account) {
          logger.info('[check_availability] Google FreeBusy had errors, trying device_freebusy fallback', { erroredEmails });
          const deviceResult = await tryDeviceFreeBusy(erroredEmails);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ source: 'auto', google: results, device_freebusy: deviceResult }, null, 2),
            }],
          };
        }

        // No via_account — return Google results with errors noted
        return { content: [{ type: 'text' as const, text: JSON.stringify({ source: 'google', ...results, note: 'Some accounts had errors. Provide via_account to try device_freebusy fallback.' }, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
