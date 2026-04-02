import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { CalendarEventRepository } from '../repositories/interfaces/calendar-event.repository.js';
import type { NotableEventRepository } from '../repositories/interfaces/notable-event.repository.js';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';
import { computeFreshness } from '../types/location.js';
import { logger } from '../utils/logger.js';
import {
  getTimePeriod,
  getDayType,
  getSuggestedEnergy,
  formatTimeUntil,
} from '../types/situation.js';

export function registerSituationTools(
  server: McpServer,
  repos: {
    location: LocationRepository;
    calendar: CalendarEventRepository;
    notableEvent: NotableEventRepository;
    message: MessageRepository;
  },
  getUserId: () => string,
  timezone: string,
): void {
  server.tool(
    'get_situation',
    "Returns a composite snapshot of the user's current situation: time, location, next event, notable events, active conversations.",
    {},
    async () => {
      const userId = getUserId();
      const now = new Date();

      // Compute time-based fields using the configured timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
      });
      const hourStr = formatter.format(now);
      const hour = parseInt(hourStr, 10);

      const dayFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
      });
      const dayOfWeekStr = dayFormatter.format(now);
      const dayMap: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      const dayOfWeek = dayMap[dayOfWeekStr] ?? 0;

      const timePeriod = getTimePeriod(hour);
      const dayType = getDayType(dayOfWeek);
      const suggestedEnergy = getSuggestedEnergy(timePeriod);

      // Fetch current location
      let currentLocation = null;
      try {
        const latest = await repos.location.getLatest(userId);
        if (latest) {
          currentLocation = {
            lat: latest.location.lat,
            lon: latest.location.lon,
            accuracy: latest.accuracy,
            timestamp: latest.timestamp,
            freshness: computeFreshness(latest.timestamp),
            place_name: latest.matchedPlace ?? null,
            place_type: null,
            address: latest.address ?? null,
          };
        }
      } catch (err) {
        logger.warn('[situation] Location fetch failed', { error: err instanceof Error ? err.message : String(err) });
      }

      // Fetch next event
      let nextEvent = null;
      let timeUntilNextEvent = null;
      try {
        const next = await repos.calendar.getNext(userId);
        if (next) {
          nextEvent = {
            title: next.title,
            start: next.startTime,
            location: next.location ?? null,
          };
          timeUntilNextEvent = formatTimeUntil(next.startTime);
        }
      } catch (err) {
        logger.warn('[situation] Calendar fetch failed', { error: err instanceof Error ? err.message : String(err) });
      }

      // Fetch unacknowledged notable events
      let notableRecentEvents: unknown[] = [];
      try {
        const notable = await repos.notableEvent.queryUnacknowledged(userId, {});
        notableRecentEvents = notable.map((e) => ({
          id: e.id,
          event_type: e.type,
          summary: e.summary,
          severity: (e.details as Record<string, unknown>)?.severity ?? 'low',
          created_at: e.timestamp,
        }));
      } catch (err) {
        logger.warn('[situation] Notable events fetch failed', { error: err instanceof Error ? err.message : String(err) });
      }

      // Count active conversations (last hour)
      let activeConversations = 0;
      try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        activeConversations = await repos.message.countActiveConversations(userId, oneHourAgo);
      } catch (err) {
        logger.warn('[situation] Active conversations count failed', { error: err instanceof Error ? err.message : String(err) });
      }

      const situation = {
        current_time: now.toISOString(),
        timezone,
        time_period: timePeriod,
        day_type: dayType,
        current_location: currentLocation,
        next_event: nextEvent,
        time_until_next_event: timeUntilNextEvent,
        suggested_energy: suggestedEnergy,
        notable_recent_events: notableRecentEvents,
        active_conversations: activeConversations,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ situation }),
          },
        ],
      };
    },
  );
}
