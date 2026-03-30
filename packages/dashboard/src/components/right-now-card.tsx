import { CalendarClock, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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

interface RightNowCardProps {
  events: CalendarEvent[];
  ticklers: Tickler[];
  overdueCount: number;
}

function formatTime24(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatCountdown(dateStr: string): string {
  const now = new Date();
  const target = new Date(dateStr);
  const diffMs = target.getTime() - now.getTime();

  if (diffMs < 0) return "now";

  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `in ${diffMin} min`;

  const diffHrs = Math.floor(diffMin / 60);
  const remainMin = diffMin % 60;
  if (remainMin === 0) return `in ${diffHrs}h`;
  return `in ${diffHrs}h ${remainMin}m`;
}

function getNextEvent(events: CalendarEvent[]): CalendarEvent | null {
  const now = new Date();
  // Find the next event that hasn't ended yet
  for (const event of events) {
    if (event.all_day) continue;
    const end = new Date(event.end);
    if (end > now) return event;
  }
  return null;
}

function getTodayTicklers(ticklers: Tickler[]): Tickler[] {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return ticklers.filter((t) => {
    const ticklerDate = t.start.split("T")[0];
    return ticklerDate === today;
  });
}

export function RightNowCard({ events, ticklers, overdueCount }: RightNowCardProps) {
  const nextEvent = getNextEvent(events);
  const todayTicklers = getTodayTicklers(ticklers);
  const hasContent = nextEvent || todayTicklers.length > 0 || overdueCount > 0;

  if (!hasContent) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
            <CalendarClock className="h-4 w-4" />
            Right Now
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm text-gray-400">Nothing pressing</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
            <CalendarClock className="h-4 w-4" />
            Right Now
          </CardTitle>
          {overdueCount > 0 && (
            <Badge variant="destructive" className="text-xs flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {overdueCount} overdue
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {nextEvent && (
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-1 h-10 rounded-full bg-blue-500 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 truncate">
                  {nextEvent.title}
                </span>
                <span className="text-xs text-blue-600 font-medium whitespace-nowrap">
                  {formatCountdown(nextEvent.start)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span>{formatTime24(nextEvent.start)} - {formatTime24(nextEvent.end)}</span>
                {nextEvent.location && (
                  <>
                    <span className="text-gray-300">|</span>
                    <span className="truncate">{nextEvent.location}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {todayTicklers.map((tickler) => (
          <div key={tickler.event_id} className="flex items-center gap-3">
            <div className="flex-shrink-0 w-1 h-6 rounded-full bg-amber-400" />
            <span className="text-sm text-gray-700 truncate">{tickler.title}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
