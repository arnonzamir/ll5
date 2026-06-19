import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { CalendarEventRepository } from '../repositories/interfaces/calendar-event.repository.js';
import type { NotableEventRepository } from '../repositories/interfaces/notable-event.repository.js';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';
import type { DeviceActivityRepository } from '../repositories/interfaces/device-activity.repository.js';
import type { BluetoothRepository } from '../repositories/interfaces/bluetooth.repository.js';
import type { LocationService } from '../services/location-service.js';
import { logger } from '../utils/logger.js';
import {
  getTimePeriod,
  getDayType,
  getSuggestedEnergy,
  formatTimeUntil,
} from '../types/situation.js';
import {
  generateToken,
  pickEffectiveTimezone,
  isTraveling,
  DEFAULT_WORKING_ZONES,
  HOME_TIMEZONE_FALLBACK,
} from '@ll5/shared';

/**
 * The slice of `user_settings.settings` (JSONB) this tool reads. Awareness is
 * ES-only and owns no Postgres access, so it reads the user's settings through
 * the gateway's authenticated `GET /user-settings` endpoint (the same JSONB the
 * dashboard reads). Timezone is system-wide, stored under these keys.
 */
interface TimezoneSettings {
  timezone?: string;
  current_timezone?: string;
  current_timezone_at?: string;
  working_zones?: string[];
}

/**
 * Fetch the user's settings JSONB from the gateway. Returns `{}` on any failure
 * (no gateway URL/secret, network error, non-2xx) so get_situation degrades to
 * the configured fallback timezone rather than failing.
 */
async function fetchUserSettings(
  gatewayUrl: string | undefined,
  authSecret: string | undefined,
  userId: string,
): Promise<TimezoneSettings> {
  if (!gatewayUrl || !authSecret) return {};
  try {
    const token = generateToken(userId, authSecret, 1);
    const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/user-settings`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn('[situation] user-settings fetch non-2xx', { status: res.status });
      return {};
    }
    return (await res.json()) as TimezoneSettings;
  } catch (err) {
    logger.warn('[situation] user-settings fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

export function registerSituationTools(
  server: McpServer,
  repos: {
    location: LocationRepository;
    calendar: CalendarEventRepository;
    notableEvent: NotableEventRepository;
    message: MessageRepository;
    deviceActivity: DeviceActivityRepository;
    bluetooth: BluetoothRepository;
  },
  getUserId: () => string,
  timezone: string,
  locationService: LocationService,
  gatewayUrl?: string,
  authSecret?: string,
): void {
  server.tool(
    'get_situation',
    "Returns a composite snapshot of the user's current situation: time, location, next event, notable events, active conversations.",
    {},
    async () => {
      const userId = getUserId();
      const now = new Date();

      // Resolve the user's EFFECTIVE (travel-aware) timezone up front — every
      // time-based field below (time_period, day_type) is computed in it, so a
      // user in SF gets SF's morning rather than Israel's afternoon. Falls back
      // to the configured tz / shared default when settings are unavailable.
      const settings = await fetchUserSettings(gatewayUrl, authSecret, userId);
      const homeTz = settings.timezone || timezone || HOME_TIMEZONE_FALLBACK;
      const tzInput = {
        currentTz: settings.current_timezone,
        currentTzAt: settings.current_timezone_at,
        homeTz,
        now,
      };
      const effectiveTz = pickEffectiveTimezone(tzInput);

      // Compute time-based fields using the effective timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: effectiveTz,
        hour: 'numeric',
        hour12: false,
      });
      const hourStr = formatter.format(now);
      const hour = parseInt(hourStr, 10);

      const dayFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: effectiveTz,
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

      // Current location via the fusion service (GPS + wifi BSSID). Embed the
      // SAME rich snapshot where_is_user returns — one shape, one vocabulary — so
      // the agent never has to reconcile two different location formats.
      let currentLocation = null;
      try {
        const fused = await locationService.getCurrentLocation(userId);
        if (fused.source !== 'none') {
          currentLocation = fused;
          if (fused.source === 'wifi' || fused.source === 'gps+wifi') {
            logger.debug('[situation] Location resolved with wifi assist', {
              source: fused.source,
              confidence: fused.confidence,
            });
          }
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

      // Phone-activity rollup (latest window) — the agent DEDUCES awake/active/
      // idle from first_interaction / interactive_now / top apps; we only state
      // the facts. Null when the source is disabled or no window yet.
      let deviceActivity = null;
      try {
        const latest = await repos.deviceActivity.getLatest(userId);
        if (latest) {
          deviceActivity = {
            window_start: latest.windowStart,
            window_end: latest.windowEnd,
            screen_on_ms: latest.screenOnMs ?? null,
            unlock_count: latest.unlockCount ?? null,
            first_interaction: latest.firstInteraction ?? null,
            last_interaction: latest.lastInteraction ?? null,
            interactive_now: latest.interactiveNow ?? null,
            top_apps: (latest.topApps ?? []).map((a) => ({
              app: a.appName ?? a.package,
              category: a.category ?? null,
              foreground_ms: a.foregroundMs ?? null,
              opens: a.opens ?? null,
            })),
          };
        }
      } catch (err) {
        logger.warn('[situation] Device activity fetch failed', { error: err instanceof Error ? err.message : String(err) });
      }

      // Currently-connected Bluetooth devices — class lets the agent infer
      // context (car → driving, headset → commute/workout, wearable → on-body).
      let bluetoothConnected: unknown[] = [];
      try {
        const connected = await repos.bluetooth.getConnected(userId);
        bluetoothConnected = connected.map((c) => ({
          name: c.deviceName ?? null,
          class: c.deviceClass ?? null,
          since: c.since,
        }));
      } catch (err) {
        logger.warn('[situation] Bluetooth fetch failed', { error: err instanceof Error ? err.message : String(err) });
      }

      // Timezone awareness block — home vs. effective (travel-aware) zone,
      // reusing the settings/effectiveTz resolved at the top of the handler.
      const timezoneBlock = {
        current: effectiveTz,
        home: homeTz,
        working_zones: settings.working_zones || DEFAULT_WORKING_ZONES,
        traveling: isTraveling(tzInput),
        current_since: settings.current_timezone_at ?? null,
      };

      const situation = {
        current_time: now.toISOString(),
        timezone: effectiveTz,
        timezone_info: timezoneBlock,
        time_period: timePeriod,
        day_type: dayType,
        current_location: currentLocation,
        next_event: nextEvent,
        time_until_next_event: timeUntilNextEvent,
        suggested_energy: suggestedEnergy,
        notable_recent_events: notableRecentEvents,
        active_conversations: activeConversations,
        device_activity: deviceActivity,
        bluetooth_connected: bluetoothConnected,
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
