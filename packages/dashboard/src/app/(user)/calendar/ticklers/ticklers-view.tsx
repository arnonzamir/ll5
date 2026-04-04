"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RefreshCw, ArrowLeft, Bell } from "lucide-react";
import Link from "next/link";
import { fetchTicklers, type Tickler } from "../calendar-server-actions";

export function TicklersView() {
  const [ticklers, setTicklers] = useState<Tickler[]>([]);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const now = new Date();
      const from = now.toISOString().slice(0, 10);
      const to = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const data = await fetchTicklers(from, to);
      setTicklers(data);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Group by date
  const grouped = new Map<string, Tickler[]>();
  for (const t of ticklers) {
    const dateKey = t.all_day
      ? t.start.slice(0, 10)
      : new Date(t.start).toLocaleDateString("en-CA");
    const list = grouped.get(dateKey) ?? [];
    list.push(t);
    grouped.set(dateKey, list);
  }

  const sortedDates = [...grouped.keys()].sort();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/calendar">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Ticklers</h1>
            <p className="text-sm text-gray-500 mt-1">Reminders and scheduled nudges (next 90 days)</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={isPending}>
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {isPending && ticklers.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">Loading...</p>
      ) : ticklers.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Bell className="h-8 w-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No ticklers in the next 90 days</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sortedDates.map((dateKey) => {
            const items = grouped.get(dateKey)!;
            const dateLabel = new Date(dateKey + "T12:00:00").toLocaleDateString([], {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
            const isToday = dateKey === new Date().toLocaleDateString("en-CA");

            return (
              <div key={dateKey}>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className={`text-sm font-medium ${isToday ? "text-blue-600" : "text-gray-500"}`}>
                    {dateLabel}
                    {isToday && <span className="ml-1 text-xs">(today)</span>}
                  </h3>
                  <div className="flex-1 border-t border-gray-100" />
                </div>
                <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                  {items.map((t, i) => {
                    const timeStr = t.all_day
                      ? "All day"
                      : new Date(t.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                    return (
                      <div key={`${t.event_id}-${i}`} className="flex items-start gap-3 px-4 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50/50">
                        <span className="text-xs text-gray-400 w-14 pt-0.5 shrink-0">{timeStr}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t.title}</span>
                            {t.recurring && (
                              <Badge variant="outline" className="text-[9px] px-1 py-0">recurring</Badge>
                            )}
                          </div>
                          {t.description && (
                            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{t.description}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
