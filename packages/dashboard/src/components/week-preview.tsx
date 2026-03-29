import { CalendarDays, Inbox, Clock, FolderKanban } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CalendarEvent {
  event_id: string;
  title: string;
  start: string;
  all_day: boolean;
  [key: string]: unknown;
}

interface Tickler {
  event_id: string;
  title: string;
  start: string;
  all_day: boolean;
  [key: string]: unknown;
}

interface WeekPreviewProps {
  events: CalendarEvent[];
  ticklers: Tickler[];
  inboxCount: number;
  waitingForCount: number;
  activeProjectCount: number;
}

function getDayName(date: Date): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dateStr = date.toISOString().split("T")[0];
  const todayStr = today.toISOString().split("T")[0];
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  if (dateStr === todayStr) return "Today";
  if (dateStr === tomorrowStr) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

function getDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

interface DayPreview {
  date: Date;
  label: string;
  eventCount: number;
}

function buildDayPreviews(events: CalendarEvent[]): DayPreview[] {
  const days: DayPreview[] = [];
  const today = new Date();

  for (let i = 1; i <= 3; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = getDateStr(date);

    const dayEvents = events.filter((e) => {
      const eventDate = e.start.split("T")[0];
      return eventDate === dateStr;
    });

    days.push({
      date,
      label: getDayName(date),
      eventCount: dayEvents.length,
    });
  }

  return days;
}

function getUpcomingTicklers(ticklers: Tickler[]): Tickler[] {
  const today = new Date().toISOString().split("T")[0];
  // Return ticklers that are after today (tomorrow onwards)
  return ticklers.filter((t) => {
    const ticklerDate = t.start.split("T")[0];
    return ticklerDate > today;
  });
}

export function WeekPreview({
  events,
  ticklers,
  inboxCount,
  waitingForCount,
  activeProjectCount,
}: WeekPreviewProps) {
  const dayPreviews = buildDayPreviews(events);
  const upcomingTicklers = getUpcomingTicklers(ticklers);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
          <CalendarDays className="h-4 w-4" />
          This Week
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* 3-day preview */}
        {dayPreviews.length > 0 && (
          <div className="flex gap-2">
            {dayPreviews.map((day) => (
              <div
                key={day.label}
                className="flex-1 rounded-md bg-gray-50 px-3 py-2 text-center"
              >
                <p className="text-xs text-gray-500 font-medium">{day.label}</p>
                <p className="text-sm font-semibold text-gray-900 mt-0.5">
                  {day.eventCount}
                  <span className="text-xs font-normal text-gray-400 ml-1">
                    {day.eventCount === 1 ? "event" : "events"}
                  </span>
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Upcoming ticklers */}
        {upcomingTicklers.length > 0 && (
          <div className="space-y-1">
            {upcomingTicklers.map((tickler) => {
              const ticklerDate = new Date(tickler.start);
              const dayLabel = getDayName(ticklerDate);
              return (
                <div key={tickler.event_id} className="flex items-center gap-2 py-0.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                  <span className="text-xs text-gray-600 truncate flex-1">{tickler.title}</span>
                  <span className="text-xs text-gray-400 flex-shrink-0">{dayLabel}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* GTD health summary */}
        <div className="flex items-center gap-3 text-xs text-gray-400 pt-1 border-t border-gray-100">
          <span className="flex items-center gap-1">
            <Inbox className="h-3 w-3" />
            {inboxCount} inbox
          </span>
          <span className="text-gray-200">|</span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {waitingForCount} waiting
          </span>
          <span className="text-gray-200">|</span>
          <span className="flex items-center gap-1">
            <FolderKanban className="h-3 w-3" />
            {activeProjectCount} projects
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
