"use client";

import { useState, useTransition, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MapPin,
  MessageSquare,
  CalendarDays,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Smartphone,
} from "lucide-react";
import {
  fetchPhoneData,
  type PhoneDataItem,
  type PhoneLocationItem,
  type PhoneMessageItem,
  type PhoneCalendarItem,
} from "./phone-data-server-actions";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch (err) {
    console.warn("[phone-data] Failed to format time:", err instanceof Error ? err.message : String(err));
    return ts;
  }
}

function TypeBadge({ type }: { type: PhoneDataItem["type"] }) {
  switch (type) {
    case "location":
      return (
        <Badge className="bg-blue-100 text-blue-800 border-transparent">
          <MapPin className="h-3 w-3 mr-1" />
          Location
        </Badge>
      );
    case "message":
      return (
        <Badge className="bg-purple-100 text-purple-800 border-transparent">
          <MessageSquare className="h-3 w-3 mr-1" />
          Message
        </Badge>
      );
    case "calendar":
      return (
        <Badge className="bg-green-100 text-green-800 border-transparent">
          <CalendarDays className="h-3 w-3 mr-1" />
          Calendar
        </Badge>
      );
  }
}

function LocationSummary({ item }: { item: PhoneLocationItem }) {
  const label =
    item.matched_place ||
    item.address ||
    `${item.lat.toFixed(4)}, ${item.lon.toFixed(4)}`;
  return (
    <span className="text-sm text-gray-700">
      {label}
      {item.accuracy != null && (
        <span className="text-gray-400 ml-2">({item.accuracy}m)</span>
      )}
    </span>
  );
}

function MessageSummary({ item }: { item: PhoneMessageItem }) {
  const prefix =
    item.is_group && item.group_name
      ? `${item.sender} @ ${item.group_name.includes('@') ? item.group_name.split('@')[0] : item.group_name} (${item.app})`
      : `${item.sender} @ ${item.app}`;
  const truncated =
    item.content.length > 80
      ? item.content.slice(0, 80) + "..."
      : item.content;
  return (
    <span className="text-sm text-gray-700">
      <span className="font-medium">{prefix}:</span> {truncated}
    </span>
  );
}

function CalendarSummary({ item }: { item: PhoneCalendarItem }) {
  return (
    <span className="text-sm text-gray-700">
      <span className="font-medium">{item.title}</span>
      <span className="text-gray-400 ml-2">{formatTime(item.start_time)}</span>
      <Badge variant="outline" className="ml-2 text-xs">
        {item.source}
      </Badge>
    </span>
  );
}

function LocationDetails({ item }: { item: PhoneLocationItem }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-gray-600">
      <div>
        <span className="text-gray-400">Lat/Lon:</span> {item.lat.toFixed(6)},{" "}
        {item.lon.toFixed(6)}
      </div>
      {item.address && (
        <div>
          <span className="text-gray-400">Address:</span> {item.address}
        </div>
      )}
      {item.matched_place && (
        <div>
          <span className="text-gray-400">Place:</span> {item.matched_place}
        </div>
      )}
      {item.accuracy != null && (
        <div>
          <span className="text-gray-400">Accuracy:</span> {item.accuracy}m
        </div>
      )}
      {item.battery_pct != null && (
        <div>
          <span className="text-gray-400">Battery:</span> {item.battery_pct}%
        </div>
      )}
    </div>
  );
}

function MessageDetails({ item }: { item: PhoneMessageItem }) {
  return (
    <div className="space-y-1 text-sm text-gray-600">
      <div>
        <span className="text-gray-400">Sender:</span> {item.sender}
      </div>
      <div>
        <span className="text-gray-400">App:</span> {item.app}
      </div>
      {item.is_group && item.group_name && (
        <div>
          <span className="text-gray-400">Group:</span> {item.group_name.includes('@') ? item.group_name.split('@')[0] : item.group_name}
        </div>
      )}
      <div>
        <span className="text-gray-400">Content:</span>{" "}
        <span className="whitespace-pre-wrap">{item.content}</span>
      </div>
    </div>
  );
}

function CalendarDetails({ item }: { item: PhoneCalendarItem }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-gray-600">
      <div>
        <span className="text-gray-400">Title:</span> {item.title}
      </div>
      <div>
        <span className="text-gray-400">Start:</span>{" "}
        {new Date(item.start_time).toLocaleString()}
      </div>
      <div>
        <span className="text-gray-400">End:</span>{" "}
        {new Date(item.end_time).toLocaleString()}
      </div>
      <div>
        <span className="text-gray-400">Source:</span> {item.source}
      </div>
      {item.location && (
        <div>
          <span className="text-gray-400">Location:</span> {item.location}
        </div>
      )}
      {item.calendar_name && (
        <div>
          <span className="text-gray-400">Calendar:</span> {item.calendar_name}
        </div>
      )}
    </div>
  );
}

function ItemDetails({ item }: { item: PhoneDataItem }) {
  switch (item.type) {
    case "location":
      return <LocationDetails item={item} />;
    case "message":
      return <MessageDetails item={item} />;
    case "calendar":
      return <CalendarDetails item={item} />;
  }
}

function PhoneDataRow({ item }: { item: PhoneDataItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="border-b border-gray-100 last:border-0 px-4 py-3 hover:bg-gray-50 transition-colors cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-gray-400 shrink-0 w-16">
          {formatTime(item.timestamp)}
        </span>
        <div className="shrink-0">
          <TypeBadge type={item.type} />
        </div>
        <div className="flex-1 min-w-0 truncate">
          {item.type === "location" && <LocationSummary item={item} />}
          {item.type === "message" && <MessageSummary item={item} />}
          {item.type === "calendar" && <CalendarSummary item={item} />}
        </div>
        <button
          className="shrink-0 text-gray-400 hover:text-gray-600"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 ml-[76px] p-3 bg-gray-50 rounded-md">
          <ItemDetails item={item} />
        </div>
      )}
    </div>
  );
}

export function PhoneDataView() {
  const [items, setItems] = useState<PhoneDataItem[]>([]);
  const [isPending, startTransition] = useTransition();
  const [filterType, setFilterType] = useState<string>("all");
  const [fromDate, setFromDate] = useState(todayISO());
  const [toDate, setToDate] = useState("");

  function load() {
    startTransition(async () => {
      const data = await fetchPhoneData({
        type: filterType as "all" | "location" | "message" | "calendar",
        from: fromDate || undefined,
        to: toDate || undefined,
      });
      setItems(data);
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-6">
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-full sm:w-[160px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="location">Locations</SelectItem>
            <SelectItem value="message">Messages</SelectItem>
            <SelectItem value="calendar">Calendar</SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="w-full sm:w-[160px]"
          aria-label="From date"
        />
        <Input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          className="w-full sm:w-[160px]"
          aria-label="To date"
        />

        <Button onClick={load} disabled={isPending} variant="outline">
          <RefreshCw
            className={`h-4 w-4 mr-1 ${isPending ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Results */}
      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
            <Smartphone className="h-12 w-12 mb-3" />
            {isPending ? (
              <p className="text-sm">Loading phone data...</p>
            ) : (
              <>
                <p className="text-sm">No phone data found.</p>
                <p className="text-xs mt-1">
                  Adjust filters or date range and try again.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-gray-100">
              {items.map((item, i) => (
                <PhoneDataRow
                  key={`${item.type}-${item.timestamp}-${i}`}
                  item={item}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {items.length > 0 && (
        <p className="text-xs text-gray-400 mt-2 text-right">
          Showing {items.length} items
        </p>
      )}
    </div>
  );
}
