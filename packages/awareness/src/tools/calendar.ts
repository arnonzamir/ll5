import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CalendarEventRepository } from '../repositories/interfaces/calendar-event.repository.js';

export function registerCalendarTools(
  server: McpServer,
  calendarRepo: CalendarEventRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_calendar_events',
    "Returns calendar events for today or a specified date range. Sorted by start time.",
    {
      from: z.string().optional().describe('Start of range (ISO 8601). Default: start of today'),
      to: z.string().optional().describe('End of range (ISO 8601). Default: end of today'),
      calendar_name: z.string().optional().describe('Filter by calendar name'),
      include_all_day: z.boolean().optional().describe('Include all-day events. Default: true'),
    },
    async (params) => {
      const userId = getUserId();
      const events = await calendarRepo.query(userId, {
        from: params.from,
        to: params.to,
        calendar_name: params.calendar_name,
        include_all_day: params.include_all_day,
      });

      const results = events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.startTime,
        end: e.endTime,
        location: e.location ?? null,
        description: e.description ?? null,
        calendar_name: e.calendarId ?? null,
        source: null,
        all_day: e.allDay ?? false,
        attendees: [],
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ events: results, total: results.length }),
          },
        ],
      };
    },
  );
}
