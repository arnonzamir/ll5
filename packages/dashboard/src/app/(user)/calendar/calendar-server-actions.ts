"use server";

import { mcpCallJsonSafe } from "@/lib/api";
import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

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
  recurring?: boolean;
  recurring_event_id?: string | null;
}

export interface GoogleConnectionStatus {
  connected: boolean;
  scopes?: string[];
  expires_at?: string;
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
  } catch (err) {
    console.error("[calendar] fetchEvents failed:", err instanceof Error ? err.message : String(err));
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
  } catch (err) {
    console.error("[calendar] fetchCalendarConfigs failed:", err instanceof Error ? err.message : String(err));
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
  } catch (err) {
    console.error("[calendar] updateCalendarAccessMode failed:", err instanceof Error ? err.message : String(err));
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
  } catch (err) {
    console.error("[calendar] fetchTicklers failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function fetchGoogleConnectionStatus(): Promise<GoogleConnectionStatus> {
  const token = await getToken();
  if (!token) return { connected: false };

  try {
    const res = await fetch(`${env.MCP_CALENDAR_URL}/api/connection-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { connected: false };
    return (await res.json()) as GoogleConnectionStatus;
  } catch (err) {
    console.error("[calendar] fetchGoogleConnectionStatus failed:", err instanceof Error ? err.message : String(err));
    return { connected: false };
  }
}

export async function getGoogleAuthUrl(): Promise<{ auth_url: string | null; error: string | null }> {
  const token = await getToken();
  if (!token) return { auth_url: null, error: "Not authenticated" };

  try {
    const res = await fetch(`${env.MCP_CALENDAR_URL}/api/auth-url`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { auth_url: null, error: `Server error (${res.status}): ${body}` };
    }
    const data = (await res.json()) as { auth_url: string };
    return { auth_url: data.auth_url, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[calendar] getGoogleAuthUrl failed:", msg);
    return { auth_url: null, error: msg };
  }
}
