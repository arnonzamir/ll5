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
  Database,
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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

function spansDay(ev: NormalizedEvent, day: Date): boolean {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return ev.start < dayEnd && ev.end > dayStart;
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
  isHoliday: boolean;
  calendarName?: string;
  calendarColor?: string;
  source?: string;
  attendees?: Array<{ email: string; name?: string; response_status?: string }>;
  htmlLink?: string;
}

// --- Normalize data ---

const HOLIDAY_KEYWORDS = ["holiday", "חופש", "חג", "vacation", "school"];

function isHolidayCalendar(calName?: string): boolean {
  if (!calName) return false;
  const lower = calName.toLowerCase();
  return HOLIDAY_KEYWORDS.some((k) => lower.includes(k));
}

function normalizeEvents(
  events: CalendarEvent[],
  ticklers: Tickler[]
): NormalizedEvent[] {
  const normalized: NormalizedEvent[] = [];

  for (const ev of events) {
    const allDay =
      ev.all_day === true || (ev.start.length <= 10 && ev.end.length <= 10);
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
      isHoliday: isHolidayCalendar(ev.calendar_name),
      calendarName: ev.calendar_name,
      calendarColor: ev.calendar_color,
      source: ev.source,
      attendees: ev.attendees?.map((a) => ({
        email: a.email,
        name: a.name ?? undefined,
        response_status: a.response_status ?? undefined,
      })),
      htmlLink: ev.html_link,
    });
  }

  for (const t of ticklers) {
    if (t.status === "cancelled") continue;
    const allDay = t.all_day !== false || t.start.length <= 10;
    const start = allDay ? new Date(t.start + "T00:00:00") : new Date(t.start);
    const end = t.end
      ? allDay
        ? new Date(t.end + "T23:59:59")
        : new Date(t.end)
      : start;
    normalized.push({
      id: `tickler-${t.event_id}`,
      title: t.title,
      description: t.description,
      start,
      end,
      allDay,
      isTickler: true,
      isHoliday: false,
      source: "tickler",
    });
  }

  return normalized.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// --- Constants ---

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 22;
const HOUR_HEIGHT = 60;
const TOTAL_HOURS = DAY_END_HOUR - DAY_START_HOUR;

// --- Hover tooltip ---

function EventTooltip({ event }: { event: NormalizedEvent }) {
  return (
    <div className="absolute z-30 left-full ml-2 top-0 w-56 rounded-lg border border-gray-200 bg-white shadow-lg p-3 pointer-events-none">
      <p className="text-sm font-medium truncate">{event.title}</p>
      <p className="text-xs text-gray-500 mt-1">
        {event.allDay
          ? "All day"
          : `${formatTime(event.start)} \u2013 ${formatTime(event.end)}`}
      </p>
      {event.location && (
        <p className="text-xs text-gray-500 mt-0.5 truncate">{event.location}</p>
      )}
      {event.calendarName && (
        <p className="text-[10px] text-gray-400 mt-1 truncate">
          {event.calendarName}
        </p>
      )}
    </div>
  );
}

// --- Full detail popover ---

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
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
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
                className="h-3 w-3 rounded-full shrink-0"
                style={{
                  backgroundColor: event.isTickler
                    ? "#f59e0b"
                    : event.isHoliday
                    ? "#10b981"
                    : event.calendarColor ?? "#3b82f6",
                }}
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
                {formatDate(event.start)} &middot; {formatTime(event.start)}{" "}
                &ndash; {formatTime(event.end)}
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

          {/* Source info */}
          <div className="flex items-center gap-2 text-xs text-gray-400 border-t border-gray-100 pt-3">
            <Database className="h-3 w-3" />
            <span>
              {event.calendarName ?? "Unknown calendar"}
              {event.source ? ` \u00b7 source: ${event.source}` : ""}
            </span>
            {event.isTickler && (
              <Badge variant="warning" className="text-[10px] ml-auto">
                Tickler
              </Badge>
            )}
            {event.isHoliday && (
              <Badge variant="success" className="text-[10px] ml-auto">
                Holiday
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Holiday/all-day banner at top ---

function HolidayBanner({
  events,
  date,
  onSelect,
}: {
  events: NormalizedEvent[];
  date: Date;
  onSelect: (e: NormalizedEvent) => void;
}) {
  const holidays = events.filter((e) => e.isHoliday && e.allDay && spansDay(e, date));
  if (holidays.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 rounded-t-lg bg-emerald-50 border border-emerald-200 px-3 py-1.5 mb-0">
      {holidays.map((h) => (
        <button
          key={h.id}
          onClick={() => onSelect(h)}
          className="text-[11px] text-emerald-700 font-medium hover:underline cursor-pointer"
        >
          {h.title}
        </button>
      ))}
    </div>
  );
}

// --- All-day section (non-holiday) ---

function AllDaySection({
  events,
  date,
  onSelect,
}: {
  events: NormalizedEvent[];
  date: Date;
  onSelect: (e: NormalizedEvent) => void;
}) {
  const allDay = events.filter(
    (e) => e.allDay && !e.isHoliday && spansDay(e, date)
  );
  if (allDay.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 border border-gray-200 border-t-0 bg-gray-50 px-3 py-1.5">
      <span className="text-[10px] text-gray-400 font-medium self-center mr-1 uppercase">
        All day
      </span>
      {allDay.map((ev) => (
        <HoverEvent key={ev.id} event={ev} onSelect={onSelect}>
          <span
            className={`text-xs px-2 py-0.5 rounded-md border font-medium truncate max-w-[200px] cursor-pointer ${
              ev.isTickler
                ? "bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100"
                : "bg-primary/5 border-primary/30 text-primary hover:bg-primary/10"
            }`}
          >
            {ev.title}
          </span>
        </HoverEvent>
      ))}
    </div>
  );
}

// --- Hover wrapper for events ---

function HoverEvent({
  event,
  onSelect,
  children,
}: {
  event: NormalizedEvent;
  onSelect: (e: NormalizedEvent) => void;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        timeoutRef.current = setTimeout(() => setHovered(true), 400);
      }}
      onMouseLeave={() => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setHovered(false);
      }}
      onClick={() => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setHovered(false);
        onSelect(event);
      }}
    >
      {children}
      {hovered && <EventTooltip event={event} />}
    </div>
  );
}

// --- Day timeline ---

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
    (e) => !e.allDay && spansDay(e, date)
  );

  const hours = Array.from(
    { length: TOTAL_HOURS },
    (_, i) => DAY_START_HOUR + i
  );

  return (
    <div>
      <HolidayBanner events={events} date={date} onSelect={onSelect} />
      <AllDaySection events={events} date={date} onSelect={onSelect} />

      {dayEvents.length === 0 ? (
        <div className="rounded-b-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
          No timed events{events.filter((e) => e.allDay && spansDay(e, date)).length > 0 ? " — all-day events shown above" : ""}
        </div>
      ) : (
      <div className="rounded-b-lg border border-gray-200 bg-white overflow-hidden">
        <div
          className="relative"
          style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
        >
          {/* Hour grid */}
          {hours.map((hour) => {
            const top = (hour - DAY_START_HOUR) * HOUR_HEIGHT;
            return (
              <div
                key={hour}
                className="absolute left-0 right-0 border-t border-gray-100"
                style={{ top }}
              >
                <span className="absolute -top-2.5 left-2 text-xs text-gray-400 bg-white px-1">
                  {`${hour}:00`}
                </span>
              </div>
            );
          })}

          {/* Current time */}
          {isToday(date) &&
            (() => {
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

          {/* Timed events */}
          {dayEvents.map((ev) => {
            // Handle cross-day events: if end is on a different day, clamp to DAY_END_HOUR
            const dayStart = startOfDay(date);
            const startHour = isSameDay(ev.start, date)
              ? ev.start.getHours() + ev.start.getMinutes() / 60
              : DAY_START_HOUR;
            const endHour = isSameDay(ev.end, date)
              ? ev.end.getHours() + ev.end.getMinutes() / 60 || DAY_END_HOUR // 0:00 = midnight = end of day
              : DAY_END_HOUR;
            const clampedStart = Math.max(startHour, DAY_START_HOUR);
            const clampedEnd = Math.min(endHour, DAY_END_HOUR);
            if (clampedEnd <= clampedStart) return null; // skip if fully outside visible hours
            const top = (clampedStart - DAY_START_HOUR) * HOUR_HEIGHT;
            const height = Math.max(
              (clampedEnd - clampedStart) * HOUR_HEIGHT,
              24
            );

            const color = ev.isTickler
              ? "bg-amber-50 border-amber-500 text-amber-900"
              : "bg-blue-50 border-blue-500 text-gray-900";

            return (
              <HoverEvent key={ev.id} event={ev} onSelect={onSelect}>
                <div
                  className={`absolute left-14 right-2 rounded-md border-l-[3px] px-2 py-1 text-left transition-opacity hover:opacity-80 cursor-pointer overflow-hidden ${color}`}
                  style={{ top, height }}
                >
                  <p className="text-xs font-medium truncate">{ev.title}</p>
                  {height >= 40 && (
                    <p className="text-[11px] text-gray-500 truncate">
                      {formatTime(ev.start)} &ndash; {formatTime(ev.end)}
                    </p>
                  )}
                </div>
              </HoverEvent>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}

// --- Week grid ---

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

  // Collect holidays spanning the week for a top banner
  const weekHolidays = events.filter(
    (e) =>
      e.isHoliday &&
      e.allDay &&
      days.some((d) => spansDay(e, d))
  );
  const uniqueHolidays = weekHolidays.filter(
    (h, i, arr) => arr.findIndex((x) => x.id === h.id) === i
  );

  return (
    <div>
      {/* Week holiday banner */}
      {uniqueHolidays.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-t-lg bg-emerald-50 border border-emerald-200 px-3 py-1.5 mb-0">
          {uniqueHolidays.map((h) => (
            <button
              key={h.id}
              onClick={() => onSelect(h)}
              className="text-[11px] text-emerald-700 font-medium hover:underline cursor-pointer"
            >
              {h.title}
            </button>
          ))}
        </div>
      )}

      <div
        className={`grid grid-cols-7 gap-px ${
          uniqueHolidays.length > 0
            ? "rounded-b-lg border border-t-0"
            : "rounded-lg border"
        } border-gray-200 bg-gray-200 overflow-hidden`}
      >
        {days.map((day) => {
          const dayStr = formatDateISO(day);
          const dayEvents = events.filter(
            (e) => !e.isHoliday && spansDay(e, day)
          );
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
                      ev.allDay
                        ? ev.isTickler
                          ? "bg-amber-50 text-amber-800 border border-amber-200"
                          : "bg-primary/10 text-primary border border-primary/20 font-medium"
                        : ev.isTickler
                        ? "bg-amber-50 text-amber-800 border border-amber-200"
                        : "bg-primary/5 text-gray-800 border border-primary/20"
                    }`}
                  >
                    {!ev.allDay && (
                      <span className="text-gray-400 mr-0.5">
                        {formatTime(ev.start)}
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
    </div>
  );
}

// --- Calendar Settings ---

function CalendarSettings({
  configs,
  onUpdate,
}: {
  configs: CalendarConfig[];
  onUpdate: (
    calendarId: string,
    mode: "ignore" | "read" | "readwrite"
  ) => void;
}) {
  const modes = ["ignore", "read", "readwrite"] as const;
  const modeLabels = {
    ignore: "Ignore",
    read: "Read",
    readwrite: "Read/Write",
  };
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
                  <Badge
                    variant="warning"
                    className="text-[10px] px-1.5 py-0"
                  >
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

  useEffect(() => {
    void fetchCalendarConfigs().then(setCalConfigs);
    // Initial data load with small delay to ensure auth cookie is available
    const timer = setTimeout(() => loadData(currentDate, viewMode), 100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAccessModeUpdate = useCallback(
    (calendarId: string, mode: "ignore" | "read" | "readwrite") => {
      setCalConfigs((prev) =>
        prev.map((c) =>
          c.calendar_id === calendarId ? { ...c, access_mode: mode } : c
        )
      );
      void updateCalendarAccessMode(calendarId, mode);
    },
    []
  );

  const loadData = useCallback((date: Date, mode: ViewMode) => {
    startTransition(async () => {
      let from: string;
      let to: string;

      if (mode === "day") {
        from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
        to = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).toISOString();
      } else {
        const ws = startOfWeek(date);
        from = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate()).toISOString();
        to = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7).toISOString();
      }

      const [eventsData, ticklersData] = await Promise.all([
        fetchEvents(from, to),
        fetchTicklers(from, to),
      ]);

      setEvents(normalizeEvents(eventsData, ticklersData));
    });
  }, []);

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
            <Settings
              className={`h-4 w-4 ${showSettings ? "text-primary" : ""}`}
            />
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

      {/* Settings */}
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
          <div className={viewMode === "week" ? "hidden sm:hidden" : ""}>
            <DayTimeline
              date={currentDate}
              events={events}
              onSelect={setSelectedEvent}
            />
          </div>
          <div className={viewMode === "week" ? "hidden sm:block" : "hidden"}>
            <WeekGrid
              weekStart={startOfWeek(currentDate)}
              events={events}
              onSelect={setSelectedEvent}
            />
          </div>
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

      {selectedEvent && (
        <EventPopover
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}
