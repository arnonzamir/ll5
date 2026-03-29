import { Calendar, CheckSquare, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

interface Action {
  id: string;
  title: string;
  due_date?: string | null;
  [key: string]: unknown;
}

interface TodayTimelineProps {
  events: CalendarEvent[];
  ticklers: Tickler[];
  dueTodayActions: Action[];
}

interface TimelineItem {
  id: string;
  type: "event" | "tickler" | "action";
  title: string;
  time: string | null; // null for all-day / dateless
  sortKey: string; // for chronological ordering
  location?: string | null;
  allDay?: boolean;
}

function formatTime24(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function getCurrentTimePosition(items: TimelineItem[]): number {
  if (items.length === 0) return -1;

  const now = new Date();
  const nowStr = now.toISOString();

  // Find position: after the last item that has started
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].sortKey <= nowStr) {
      return i;
    }
  }
  return -1; // before all items
}

function buildTimelineItems(
  events: CalendarEvent[],
  ticklers: Tickler[],
  actions: Action[]
): TimelineItem[] {
  const today = new Date().toISOString().split("T")[0];
  const items: TimelineItem[] = [];

  // All-day events go first
  for (const event of events) {
    if (event.all_day) {
      items.push({
        id: `event-${event.event_id}`,
        type: "event",
        title: event.title,
        time: null,
        sortKey: "0000-allday",
        location: event.location,
        allDay: true,
      });
    }
  }

  // All-day ticklers
  for (const tickler of ticklers) {
    const ticklerDate = tickler.start.split("T")[0];
    if (ticklerDate === today && tickler.all_day) {
      items.push({
        id: `tickler-${tickler.event_id}`,
        type: "tickler",
        title: tickler.title,
        time: null,
        sortKey: "0001-allday-tickler",
        allDay: true,
      });
    }
  }

  // Timed events
  for (const event of events) {
    if (!event.all_day) {
      items.push({
        id: `event-${event.event_id}`,
        type: "event",
        title: event.title,
        time: formatTime24(event.start),
        sortKey: event.start,
        location: event.location,
      });
    }
  }

  // Timed ticklers
  for (const tickler of ticklers) {
    const ticklerDate = tickler.start.split("T")[0];
    if (ticklerDate === today && !tickler.all_day) {
      items.push({
        id: `tickler-${tickler.event_id}`,
        type: "tickler",
        title: tickler.title,
        time: formatTime24(tickler.start),
        sortKey: tickler.start,
      });
    }
  }

  // Due-today actions (no specific time, placed at end of timed items)
  for (const action of actions) {
    items.push({
      id: `action-${action.id}`,
      type: "action",
      title: action.title,
      time: null,
      sortKey: "9999-action",
    });
  }

  // Sort: all-day first, then by time, actions at end
  items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return items;
}

function NowMarker() {
  return (
    <div className="relative flex items-center py-1.5">
      <div className="absolute left-0 w-[11px] h-[11px] rounded-full bg-blue-500 ring-2 ring-blue-100 z-10" />
      <div className="ml-6 h-px flex-1 bg-blue-300" />
      <span className="ml-2 text-xs text-blue-500 font-medium tabular-nums">
        {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}
      </span>
    </div>
  );
}

export function TodayTimeline({ events, ticklers, dueTodayActions }: TodayTimelineProps) {
  const items = buildTimelineItems(events, ticklers, dueTodayActions);
  const currentPosition = getCurrentTimePosition(items);

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Today
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm text-gray-400">Clear day</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Today
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[5px] top-2 bottom-2 w-px bg-gray-200" />

          <div className="space-y-0">
            {/* If current time is before all items, show marker at top */}
            {currentPosition === -1 && items.length > 0 && (
              <NowMarker />
            )}

            {items.map((item, index) => {
              const isPast = currentPosition >= 0 && index <= currentPosition;
              const showNowAfter = index === currentPosition && index < items.length - 1;

              return (
                <div key={item.id}>
                  <div className={`relative flex items-start gap-4 py-1.5 ${isPast ? "opacity-50" : ""}`}>
                    {/* Dot on timeline */}
                    <div className="relative flex-shrink-0 mt-1.5">
                      {item.type === "event" && (
                        <div className="w-[11px] h-[11px] rounded-full border-2 border-blue-500 bg-white z-10 relative" />
                      )}
                      {item.type === "tickler" && (
                        <div className="w-[11px] h-[11px] rounded-full bg-amber-400 z-10 relative" />
                      )}
                      {item.type === "action" && (
                        <div className="w-[11px] h-[11px] rounded-sm border-2 border-gray-400 bg-white z-10 relative" />
                      )}
                    </div>

                    {/* Time */}
                    <div className="w-11 flex-shrink-0 text-right">
                      {item.time ? (
                        <span className="text-xs text-gray-500 tabular-nums font-medium">{item.time}</span>
                      ) : item.allDay ? (
                        <span className="text-xs text-gray-400">all day</span>
                      ) : (
                        <span className="text-xs text-gray-300">--:--</span>
                      )}
                    </div>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {item.type === "event" && <Calendar className="h-3 w-3 text-blue-500 flex-shrink-0" />}
                        {item.type === "action" && <CheckSquare className="h-3 w-3 text-gray-400 flex-shrink-0" />}
                        <span className="text-sm text-gray-900 truncate">{item.title}</span>
                      </div>
                      {item.location && (
                        <p className="text-xs text-gray-400 truncate mt-0.5 ml-[18px]">{item.location}</p>
                      )}
                    </div>
                  </div>

                  {/* Current time marker — shown between past and future items */}
                  {showNowAfter && <NowMarker />}
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
