"use client";

import { useState, useTransition, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Users,
  X,
  RefreshCw,
  Settings,
} from "lucide-react";
import {
  fetchEvents,
  fetchTicklers,
  fetchCalendarConfigs,
  updateCalendarAccessMode,
  type CalendarEvent,
  type Tickler,
  type CalendarConfig,
} from "./calendar-server-actions";

// --- Date helpers ---

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  const day = r.getDay();
  // Monday-based week
  const diff = day === 0 ? -6 : 1 - day;
  r.setDate(r.getDate() + diff);
  return r;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatDateISO(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(d: Date): boolean {
  return isSameDay(d, new Date());
}

// --- Types ---

interface NormalizedEvent {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  isTickler: boolean;
  attendees?: Array<{ email: string; name?: string; response_status?: string }>;
  htmlLink?: string;
}

// --- Normalize data ---

function normalizeEvents(
  events: CalendarEvent[],
  ticklers: Tickler[]
): NormalizedEvent[] {
  const normalized: NormalizedEvent[] = [];

  for (const ev of events) {
    const allDay = ev.all_day === true || (ev.start.length <= 10 && ev.end.length <= 10);
    const start = allDay ? new Date(ev.start + "T00:00:00") : new Date(ev.start);
    const end = allDay ? new Date(ev.end + "T23:59:59") : new Date(ev.end);

    normalized.push({
      id: ev.event_id,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      start,
      end,
      allDay,
      isTickler: false,
      attendees: ev.attendees?.map((a) => ({
        email: a.email,
        name: a.name ?? undefined,
        response_status: a.response_status,
      })),
      htmlLink: ev.html_link,
    });
  }

  for (const t of ticklers) {
    if (t.status === 'cancelled') continue;
    const allDay = t.all_day !== false || t.start.length <= 10;
    const start = allDay ? new Date(t.start + "T00:00:00") : new Date(t.start);
    const end = t.end ? (allDay ? new Date(t.end + "T23:59:59") : new Date(t.end)) : start;
    normalized.push({
      id: `tickler-${t.event_id}`,
      title: t.title,
      description: t.description,
      start,
      end,
      allDay,
      isTickler: true,
    });
  }

  return normalized.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// --- Constants ---

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 22;
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_HOURS = DAY_END_HOUR - DAY_START_HOUR;

// --- Components ---

function EventPopover({
  event,
  onClose,
}: {
  event: NormalizedEvent;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <Card ref={popoverRef} className="w-full max-w-md shadow-lg">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <div
                className={`h-3 w-3 rounded-full shrink-0 ${
                  event.isTickler ? "bg-amber-500" : "bg-primary"
                }`}
              />
              <CardTitle className="text-base">{event.title}</CardTitle>
            </div>
            <button
              onClick={onClose}
              className="rounded-sm p-1 opacity-70 hover:opacity-100 transition-opacity"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Clock className="h-4 w-4 shrink-0" />
            {event.allDay ? (
              <span>All day &middot; {formatDate(event.start)}</span>
            ) : (
              <span>
                {formatDate(event.start)} &middot; {formatTime(event.start)} &ndash;{" "}
                {formatTime(event.end)}
              </span>
            )}
          </div>

          {event.location && (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <MapPin className="h-4 w-4 shrink-0" />
              <span>{event.location}</span>
            </div>
          )}

          {event.attendees && event.attendees.length > 0 && (
            <div className="flex items-start gap-2 text-sm text-gray-600">
              <Users className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="flex flex-wrap gap-1">
                {event.attendees.map((a, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">
                    {a.name || a.email}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {event.description && (
            <p className="text-sm text-gray-600 whitespace-pre-wrap border-t border-gray-100 pt-3">
              {event.description}
            </p>
          )}

          {event.isTickler && (
            <Badge variant="warning" className="text-xs">
              Tickler
            </Badge>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AllDaySection({
  events,
  onSelect,
}: {
  events: NormalizedEvent[];
  onSelect: (e: NormalizedEvent) => void;
}) {
  if (events.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 rounded-lg border border-gray-200 bg-gray-50 p-2 mb-2">
      <span className="text-xs text-gray-400 font-medium self-center mr-1">
        ALL DAY
      </span>
      {events.map((ev) => (
        <button
          key={ev.id}
          onClick={() => onSelect(ev)}
          className={`text-xs px-2 py-1 rounded-md border font-medium truncate max-w-[200px] transition-colors cursor-pointer ${
            ev.isTickler
              ? "bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100"
              : "bg-primary/5 border-primary/30 text-primary hover:bg-primary/10"
          }`}
        >
          {ev.title}
        </button>
      ))}
    </div>
  );
}

function DayTimeline({
  date,
  events,
  onSelect,
}: {
  date: Date;
  events: NormalizedEvent[];
  onSelect: (e: NormalizedEvent) => void;
}) {
  const dayEvents = events.filter(
    (e) => !e.allDay && isSameDay(e.start, date)
  );
  const allDayEvents = events.filter(
    (e) => e.allDay && isSameDay(e.start, date)
  );

  const hours = Array.from(
    { length: TOTAL_HOURS },
    (_, i) => DAY_START_HOUR + i
  );

  return (
    <div>
      <AllDaySection events={allDayEvents} onSelect={onSelect} />

      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="relative" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
          {/* Hour grid lines */}
          {hours.map((hour) => {
            const top = (hour - DAY_START_HOUR) * HOUR_HEIGHT;
            return (
              <div
                key={hour}
                className="absolute left-0 right-0 border-t border-gray-100"
                style={{ top }}
              >
                <span className="absolute -top-2.5 left-2 text-xs text-gray-400 bg-white px-1">
                  {hour === 0
                    ? "12 AM"
                    : hour < 12
                    ? `${hour} AM`
                    : hour === 12
                    ? "12 PM"
                    : `${hour - 12} PM`}
                </span>
              </div>
            );
          })}

          {/* Current time indicator */}
          {isToday(date) && (() => {
            const now = new Date();
            const nowHour = now.getHours() + now.getMinutes() / 60;
            if (nowHour >= DAY_START_HOUR && nowHour <= DAY_END_HOUR) {
              const top = (nowHour - DAY_START_HOUR) * HOUR_HEIGHT;
              return (
                <div
                  className="absolute left-0 right-0 z-10 pointer-events-none"
                  style={{ top }}
                >
                  <div className="flex items-center">
                    <div className="h-2.5 w-2.5 rounded-full bg-red-500 -ml-1" />
                    <div className="flex-1 h-px bg-red-500" />
                  </div>
                </div>
              );
            }
            return null;
          })()}

          {/* Events positioned absolutely */}
          {dayEvents.map((ev) => {
            const startHour =
              ev.start.getHours() + ev.start.getMinutes() / 60;
            const endHour = ev.end.getHours() + ev.end.getMinutes() / 60;
            const clampedStart = Math.max(startHour, DAY_START_HOUR);
            const clampedEnd = Math.min(endHour, DAY_END_HOUR);
            const top = (clampedStart - DAY_START_HOUR) * HOUR_HEIGHT;
            const height = Math.max(
              (clampedEnd - clampedStart) * HOUR_HEIGHT,
              24
            );

            return (
              <button
                key={ev.id}
                onClick={() => onSelect(ev)}
                className={`absolute left-14 right-2 rounded-md border-l-[3px] px-2 py-1 text-left transition-opacity hover:opacity-80 cursor-pointer overflow-hidden ${
                  ev.isTickler
                    ? "bg-amber-50 border-amber-500 text-amber-900"
                    : "bg-primary/5 border-primary text-gray-900"
                }`}
                style={{ top, height }}
              >
                <p className="text-xs font-medium truncate">{ev.title}</p>
                {height >= 40 && (
                  <p className="text-[11px] text-gray-500 truncate">
                    {formatTime(ev.start)} &ndash; {formatTime(ev.end)}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WeekGrid({
  weekStart,
  events,
  onSelect,
}: {
  weekStart: Date;
  events: NormalizedEvent[];
  onSelect: (e: NormalizedEvent) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <div className="grid grid-cols-7 gap-px rounded-lg border border-gray-200 bg-gray-200 overflow-hidden">
      {days.map((day) => {
        const dayStr = formatDateISO(day);
        const dayEvents = events.filter((e) => {
          const evDay = formatDateISO(e.start);
          return evDay === dayStr;
        });
        const today = isToday(day);

        return (
          <div
            key={dayStr}
            className={`bg-white min-h-[140px] p-1.5 ${
              today ? "bg-primary/[0.02]" : ""
            }`}
          >
            <div className="flex items-center gap-1 mb-1">
              <span
                className={`text-xs font-medium ${
                  today
                    ? "bg-primary text-white rounded-full h-5 w-5 flex items-center justify-center"
                    : "text-gray-500"
                }`}
              >
                {day.getDate()}
              </span>
              <span className="text-[10px] text-gray-400 uppercase">
                {day.toLocaleDateString("en-US", { weekday: "short" })}
              </span>
            </div>
            <div className="space-y-0.5">
              {dayEvents.map((ev) => (
                <button
                  key={ev.id}
                  onClick={() => onSelect(ev)}
                  className={`w-full text-left text-[11px] leading-tight px-1 py-0.5 rounded truncate transition-opacity hover:opacity-80 cursor-pointer ${
                    ev.isTickler
                      ? "bg-amber-50 text-amber-800 border border-amber-200"
                      : "bg-primary/5 text-gray-800 border border-primary/20"
                  }`}
                >
                  {!ev.allDay && (
                    <span className="text-gray-400 mr-0.5">
                      {formatTime(ev.start).replace(":00", "").toLowerCase()}
                    </span>
                  )}
                  {ev.title}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Calendar Settings ---

function CalendarSettings({
  configs,
  onUpdate,
}: {
  configs: CalendarConfig[];
  onUpdate: (calendarId: string, mode: "ignore" | "read" | "readwrite") => void;
}) {
  const modes = ["ignore", "read", "readwrite"] as const;
  const modeLabels = { ignore: "Ignore", read: "Read", readwrite: "Read/Write" };
  const modeColors = {
    ignore: "text-gray-400",
    read: "text-blue-600",
    readwrite: "text-green-600",
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-gray-500">
          Calendar Sources
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {configs.map((cal) => (
            <div
              key={cal.calendar_id}
              className="flex items-center justify-between gap-3 py-1.5 border-b border-gray-50 last:border-0"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ backgroundColor: cal.color || "#4285f4" }}
                />
                <span className="text-sm truncate">{cal.name}</span>
                {cal.role === "tickler" && (
                  <Badge variant="warning" className="text-[10px] px-1.5 py-0">
                    tickler
                  </Badge>
                )}
              </div>
              <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
                {modes.map((mode) => (
                  <button
                    key={mode}
                    onClick={() => onUpdate(cal.calendar_id, mode)}
                    className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                      cal.access_mode === mode
                        ? `bg-gray-100 ${modeColors[mode]}`
                        : "text-gray-400 hover:text-gray-600"
                    }`}
                  >
                    {modeLabels[mode]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {configs.length === 0 && (
          <p className="text-sm text-gray-400">
            No calendars configured. Connect Google first.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// --- Main View ---

type ViewMode = "day" | "week";

export function CalendarView() {
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [currentDate, setCurrentDate] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<NormalizedEvent | null>(
    null
  );
  const [showSettings, setShowSettings] = useState(false);
  const [calConfigs, setCalConfigs] = useState<CalendarConfig[]>([]);
  const [isPending, startTransition] = useTransition();

  // Load calendar configs on mount
  useEffect(() => {
    void fetchCalendarConfigs().then(setCalConfigs);
  }, []);

  const handleAccessModeUpdate = useCallback(
    (calendarId: string, mode: "ignore" | "read" | "readwrite") => {
      // Optimistic update
      setCalConfigs((prev) =>
        prev.map((c) =>
          c.calendar_id === calendarId ? { ...c, access_mode: mode } : c
        )
      );
      // Persist
      void updateCalendarAccessMode(calendarId, mode);
    },
    []
  );

  const loadData = useCallback(
    (date: Date, mode: ViewMode) => {
      startTransition(async () => {
        let from: string;
        let to: string;

        if (mode === "day") {
          from = formatDateISO(date);
          to = formatDateISO(addDays(date, 1));
        } else {
          const ws = startOfWeek(date);
          from = formatDateISO(ws);
          to = formatDateISO(addDays(ws, 7));
        }

        const [eventsData, ticklersData] = await Promise.all([
          fetchEvents(from, to),
          fetchTicklers(from, to),
        ]);

        setEvents(normalizeEvents(eventsData, ticklersData));
      });
    },
    []
  );

  useEffect(() => {
    loadData(currentDate, viewMode);
  }, [currentDate, viewMode, loadData]);

  function goToday() {
    setCurrentDate(startOfDay(new Date()));
  }

  function goPrev() {
    setCurrentDate((d) => addDays(d, viewMode === "day" ? -1 : -7));
  }

  function goNext() {
    setCurrentDate((d) => addDays(d, viewMode === "day" ? 1 : 7));
  }

  const headerLabel =
    viewMode === "day"
      ? currentDate.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : (() => {
          const ws = startOfWeek(currentDate);
          const we = addDays(ws, 6);
          const sameMonth = ws.getMonth() === we.getMonth();
          if (sameMonth) {
            return `${ws.toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
            })} \u2013 ${we.getDate()}, ${we.getFullYear()}`;
          }
          return `${ws.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })} \u2013 ${we.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}, ${we.getFullYear()}`;
        })();

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Button variant="outline" size="sm" onClick={goToday}>
          Today
        </Button>

        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" onClick={goPrev} aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={goNext} aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <span className="text-sm font-medium text-gray-700 min-w-0 truncate">
          {headerLabel}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSettings((s) => !s)}
            aria-label="Calendar settings"
          >
            <Settings className={`h-4 w-4 ${showSettings ? "text-primary" : ""}`} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => loadData(currentDate, viewMode)}
            disabled={isPending}
            aria-label="Refresh"
          >
            <RefreshCw
              className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`}
            />
          </Button>

          {/* View toggle - hidden on mobile (always day view) */}
          <div className="hidden sm:flex items-center rounded-md border border-gray-200 p-0.5">
            <button
              onClick={() => setViewMode("day")}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                viewMode === "day"
                  ? "bg-primary text-white"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              Day
            </button>
            <button
              onClick={() => setViewMode("week")}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                viewMode === "week"
                  ? "bg-primary text-white"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              Week
            </button>
          </div>
        </div>
      </div>

      {/* Calendar settings panel */}
      {showSettings && (
        <div className="mb-4">
          <CalendarSettings
            configs={calConfigs}
            onUpdate={handleAccessModeUpdate}
          />
        </div>
      )}

      {/* Calendar content */}
      {isPending && events.length === 0 ? (
        <div className="flex items-center justify-center h-64 text-sm text-gray-400">
          Loading calendar...
        </div>
      ) : events.length === 0 && !isPending ? (
        <div className="flex items-center justify-center h-64 text-sm text-gray-400">
          No events for this period
        </div>
      ) : (
        <>
          {/* Day view (always visible on mobile, toggled on desktop) */}
          <div className={viewMode === "week" ? "hidden sm:hidden" : ""}>
            <DayTimeline
              date={currentDate}
              events={events}
              onSelect={setSelectedEvent}
            />
          </div>

          {/* Week view (only on desktop) */}
          <div
            className={
              viewMode === "week" ? "hidden sm:block" : "hidden"
            }
          >
            <WeekGrid
              weekStart={startOfWeek(currentDate)}
              events={events}
              onSelect={setSelectedEvent}
            />
          </div>

          {/* Mobile always gets day view */}
          {viewMode === "week" && (
            <div className="sm:hidden">
              <DayTimeline
                date={currentDate}
                events={events}
                onSelect={setSelectedEvent}
              />
            </div>
          )}
        </>
      )}

      {/* Event detail popover */}
      {selectedEvent && (
        <EventPopover
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}
