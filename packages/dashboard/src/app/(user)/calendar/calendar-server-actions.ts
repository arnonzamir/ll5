"use server";

import { mcpCallJsonSafe } from "@/lib/api";

export interface CalendarConfig {
  calendar_id: string;
  name: string;
  access_mode: "ignore" | "read" | "readwrite";
  role: string;
  color: string;
  google_access_role?: string;
  primary?: boolean;
  source?: string;
}

export interface CalendarEvent {
  event_id: string;
  calendar_id?: string;
  calendar_name?: string;
  calendar_color?: string;
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  source?: string;
  location?: string | null;
  description?: string | null;
  attendees?: Array<{ email: string; name?: string | null; response_status?: string }>;
  html_link?: string;
  status?: string;
  recurring?: boolean;
}

export interface Tickler {
  event_id: string;
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  description?: string | null;
  status?: string;
}

export async function fetchEvents(
  from: string,
  to: string
): Promise<CalendarEvent[]> {
  try {
    const raw = await mcpCallJsonSafe<Record<string, unknown>>(
      "calendar",
      "list_events",
      { from, to, include_all_day: true }
    );
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as CalendarEvent[];
    for (const val of Object.values(raw)) {
      if (Array.isArray(val)) return val as CalendarEvent[];
    }
    return [];
  } catch {
    return [];
  }
}

export async function fetchCalendarConfigs(
  refresh = false
): Promise<CalendarConfig[]> {
  try {
    const raw = await mcpCallJsonSafe<unknown>(
      "calendar",
      "list_calendars",
      { refresh }
    );
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as CalendarConfig[];
    if (typeof raw === "object" && raw !== null) {
      for (const val of Object.values(raw)) {
        if (Array.isArray(val)) return val as CalendarConfig[];
      }
    }
    return [];
  } catch {
    return [];
  }
}

export async function updateCalendarAccessMode(
  calendarId: string,
  accessMode: "ignore" | "read" | "readwrite"
): Promise<boolean> {
  try {
    const raw = await mcpCallJsonSafe<Record<string, unknown>>(
      "calendar",
      "configure_calendar",
      { calendar_id: calendarId, access_mode: accessMode }
    );
    return raw?.updated === true;
  } catch {
    return false;
  }
}

export async function fetchTicklers(
  from: string,
  to: string
): Promise<Tickler[]> {
  try {
    const raw = await mcpCallJsonSafe<Record<string, unknown>>(
      "calendar",
      "list_ticklers",
      { from, to }
    );
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as Tickler[];
    for (const val of Object.values(raw)) {
      if (Array.isArray(val)) return val as Tickler[];
    }
    return [];
  } catch {
    return [];
  }
}
