import { logger } from '../utils/logger.js';

interface CalendarEvent {
  event_id: string;
  calendar_id: string;
  calendar_name: string;
  calendar_color: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  attendees: { email: string; name: string | null; response_status: string }[];
  html_link: string;
  status: string;
  recurring: boolean;
}

interface TicklerEvent {
  event_id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  description: string | null;
  status: string;
}

/**
 * Simple HTTP client for the Google MCP REST API endpoints.
 */
export class GoogleCalendarClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async fetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }

    const response = await globalThis.fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google MCP API ${path} returned ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getEvents(from?: string, to?: string, calendarId?: string): Promise<CalendarEvent[]> {
    const params: Record<string, string> = {};
    if (from) params.from = from;
    if (to) params.to = to;
    if (calendarId) params.calendar_id = calendarId;

    const result = await this.fetch<{ events: CalendarEvent[] }>('/api/events', params);
    return result.events;
  }

  async getTicklers(from?: string, to?: string): Promise<TicklerEvent[]> {
    const params: Record<string, string> = {};
    if (from) params.from = from;
    if (to) params.to = to;

    const result = await this.fetch<{ events: TicklerEvent[] }>('/api/ticklers', params);
    return result.events;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await globalThis.fetch(new URL('/health', this.baseUrl).toString());
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function createGoogleCalendarClient(
  url: string | undefined,
  apiKey: string | undefined,
): GoogleCalendarClient | null {
  if (!url || !apiKey) {
    logger.info('Google MCP URL or API key not configured — calendar sync/review disabled');
    return null;
  }
  return new GoogleCalendarClient(url, apiKey);
}
