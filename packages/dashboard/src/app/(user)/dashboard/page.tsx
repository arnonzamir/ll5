import { RightNowCard } from "@/components/right-now-card";
import { TodayTimeline } from "@/components/today-timeline";
import { WeekPreview } from "@/components/week-preview";
import { ChatWidget } from "@/components/chat-widget";
import { mcpCallJsonSafe } from "@/lib/api";

export const metadata = { title: "Dashboard - LL5" };

interface GtdHealth {
  inbox_count?: number;
  inboxCount?: number;
  due_today_count?: number;
  overdue_count?: number;
  overdueActionCount?: number;
  waiting_for_count?: number;
  staleWaitingCount?: number;
  active_project_count?: number;
  activeProjectCount?: number;
  [key: string]: unknown;
}

interface GtdAction {
  id: string;
  title: string;
  due_date?: string | null;
  status?: string;
  [key: string]: unknown;
}

interface CalendarEvent {
  event_id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string | null;
  [key: string]: unknown;
}

interface Tickler {
  event_id: string;
  title: string;
  start: string;
  all_day: boolean;
  [key: string]: unknown;
}

export default async function DashboardPage() {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const threeDaysFromNow = new Date(today);
  threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
  const threeDaysStr = threeDaysFromNow.toISOString();

  // Fetch GTD data and Google data in parallel
  // Google MCP calls use mcpCallJsonSafe — returns null if google MCP is unavailable
  const [healthRaw, dueTodayRaw, overdueRaw, eventsRaw, ticklersRaw] = await Promise.all([
    mcpCallJsonSafe<Record<string, unknown>>("gtd", "get_gtd_health"),
    mcpCallJsonSafe<Record<string, unknown>>("gtd", "list_actions", {
      due_before: todayStr,
      status: "active",
      limit: 20,
    }),
    mcpCallJsonSafe<Record<string, unknown>>("gtd", "list_actions", {
      overdue: true,
      limit: 5,
    }),
    mcpCallJsonSafe<Record<string, unknown>>("google", "list_events"),
    mcpCallJsonSafe<Record<string, unknown>>("google", "list_ticklers", {
      to: threeDaysStr,
    }),
  ]);

  // Extract GTD health
  const health = (healthRaw?.health ?? healthRaw ?? {}) as GtdHealth;
  const inboxCount = health?.inbox_count ?? health?.inboxCount ?? 0;
  const overdueCount = health?.overdue_count ?? health?.overdueActionCount ?? 0;
  const waitingForCount = health?.waiting_for_count ?? health?.staleWaitingCount ?? 0;
  const activeProjectCount = health?.active_project_count ?? health?.activeProjectCount ?? 0;

  // Extract due-today actions
  const dueTodayActions = (
    (dueTodayRaw as Record<string, unknown>)?.actions ??
    (Array.isArray(dueTodayRaw) ? dueTodayRaw : [])
  ) as GtdAction[];

  // Extract overdue actions (for count only)
  const overdueActions = (
    (overdueRaw as Record<string, unknown>)?.actions ??
    (Array.isArray(overdueRaw) ? overdueRaw : [])
  ) as GtdAction[];
  const effectiveOverdueCount = overdueActions.length > 0 ? overdueActions.length : overdueCount;

  // Extract calendar events (null if google MCP unavailable)
  const events: CalendarEvent[] = eventsRaw
    ? (Array.isArray(eventsRaw) ? eventsRaw : []) as CalendarEvent[]
    : [];

  // Extract ticklers (null if google MCP unavailable)
  const ticklersData = ticklersRaw as Record<string, unknown> | null;
  const ticklers: Tickler[] = ticklersData
    ? ((ticklersData?.ticklers ?? (Array.isArray(ticklersData) ? ticklersData : [])) as Tickler[])
    : [];

  // For the week preview, we need events for the next 3 days
  // The events call defaults to today, so we need a separate call for the 3-day window
  // But to avoid an extra call, we'll re-use ticklers (which already spans 3 days)
  // and fetch 3-day events separately
  let weekEvents: CalendarEvent[] = [];
  try {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEventsRaw = await mcpCallJsonSafe<Record<string, unknown>>("google", "list_events", {
      from: tomorrow.toISOString(),
      to: threeDaysStr,
    });
    if (weekEventsRaw) {
      weekEvents = (Array.isArray(weekEventsRaw) ? weekEventsRaw : []) as CalendarEvent[];
    }
  } catch {
    // Google MCP unavailable — no week events
  }

  return (
    <div className="flex gap-6 overflow-hidden" style={{ height: 'calc(100vh - 6rem)' }}>
      {/* Left panel — Insight-driven view */}
      <div className="w-full lg:w-[45%] overflow-y-auto space-y-4 pb-6 min-h-0">
        <RightNowCard
          events={events}
          ticklers={ticklers}
          overdueCount={effectiveOverdueCount}
        />

        <TodayTimeline
          events={events}
          ticklers={ticklers}
          dueTodayActions={dueTodayActions}
        />

        <WeekPreview
          events={weekEvents}
          ticklers={ticklers}
          inboxCount={inboxCount}
          waitingForCount={waitingForCount}
          activeProjectCount={activeProjectCount}
        />
      </div>

      {/* Right panel — Chat (hidden on mobile, shown on lg+) */}
      <div className="hidden lg:flex lg:w-[55%] lg:flex-col min-h-0">
        <ChatWidget />
      </div>
    </div>
  );
}
