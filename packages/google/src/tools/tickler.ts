import { z } from 'zod';
import { google } from 'googleapis';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import type { CalendarConfigRepository } from '../repositories/interfaces/calendar-config.repository.js';
import { getAuthenticatedClient, type GoogleClientConfig } from '../utils/google-client.js';
import { logAudit } from '@ll5/shared';
import { logger } from '../utils/logger.js';

const TICKLER_CALENDAR_NAME = 'LL5 System';
const TICKLER_COLOR = '#e67c73'; // flamingo

/**
 * Get or create the tickler calendar.
 * On first call, creates a new Google Calendar and stores config with role='tickler'.
 */
async function getOrCreateTicklerCalendar(
  config: GoogleClientConfig,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
  userId: string,
): Promise<string> {
  // Check if we already have a tickler calendar
  const existing = await calendarConfigRepo.getByRole(userId, 'tickler');
  if (existing) {
    return existing.calendar_id;
  }

  // Create the calendar via Google API
  const auth = await getAuthenticatedClient(config, tokenRepo, userId);
  const calendarApi = google.calendar({ version: 'v3', auth });

  const response = await calendarApi.calendars.insert({
    requestBody: {
      summary: TICKLER_CALENDAR_NAME,
      description: 'Managed by LL5 — temporal nudges and tickler reminders',
      timeZone: 'Asia/Jerusalem',
    },
  });

  const calendarId = response.data.id;
  if (!calendarId) {
    throw new Error('Failed to create tickler calendar — no ID returned');
  }

  // Store in config with role='tickler'
  await calendarConfigRepo.upsert(userId, {
    calendar_id: calendarId,
    calendar_name: TICKLER_CALENDAR_NAME,
    color: TICKLER_COLOR,
    role: 'tickler',
  });

  logger.info('Created tickler calendar', { calendarId, userId });
  return calendarId;
}

export function registerTicklerTools(
  server: McpServer,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
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
      due_time: z.string().optional().describe('Specific time (HH:MM, 24h format). If omitted, creates an all-day event.'),
      description: z.string().optional().describe('Additional context or notes'),
      category: z.string().optional().describe('Category: health, admin, planning, financial, social, errands'),
    },
    async ({ title, due_date, due_time, description, category }) => {
      const userId = getUserId();
      const calendarId = await getOrCreateTicklerCalendar(config, tokenRepo, calendarConfigRepo, userId);
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const calendarApi = google.calendar({ version: 'v3', auth });

      const fullTitle = category ? `[${category}] ${title}` : title;
      const isAllDay = !due_time;

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
        const startDateTime = `${due_date}T${due_time}:00`;
        const endDate = new Date(startDateTime);
        endDate.setMinutes(endDate.getMinutes() + 30); // 30-min default duration
        eventBody.start = { dateTime: startDateTime, timeZone: 'Asia/Jerusalem' };
        eventBody.end = { dateTime: endDate.toISOString(), timeZone: 'Asia/Jerusalem' };
      }

      // Add a popup reminder
      eventBody.reminders = {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: isAllDay ? 480 : 30 }, // 8h before all-day, 30min before timed
        ],
      };

      const response = await calendarApi.events.insert({
        calendarId,
        requestBody: eventBody as Parameters<typeof calendarApi.events.insert>[0] extends { requestBody?: infer R } ? R : never,
      });

      logAudit({ user_id: userId, source: 'google', action: 'create', entity_type: 'tickler', entity_id: response.data.id ?? '', summary: `Created tickler: ${fullTitle}` });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            event_id: response.data.id ?? '',
            title: fullTitle,
            due_date,
            due_time: due_time ?? 'all-day',
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

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const defaultFrom = include_past
        ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
        : startOfDay.toISOString();
      const defaultTo = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const timeMin = from ? new Date(from).toISOString() : defaultFrom;
      const timeMax = to ? new Date(to).toISOString() : defaultTo;

      const response = await calendarApi.events.list({
        calendarId: existing.calendar_id,
        timeMin,
        timeMax,
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
    'Mark a tickler as done by deleting it from the LL5 System calendar.',
    {
      event_id: z.string().describe('The event ID of the tickler to complete'),
    },
    async ({ event_id }) => {
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

      await calendarApi.events.delete({
        calendarId: existing.calendar_id,
        eventId: event_id,
      });

      logAudit({ user_id: userId, source: 'google', action: 'complete', entity_type: 'tickler', entity_id: event_id, summary: `Completed tickler: ${event_id}` });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, event_id }),
        }],
      };
    },
  );
}
