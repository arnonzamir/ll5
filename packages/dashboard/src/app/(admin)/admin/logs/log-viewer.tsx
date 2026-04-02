"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, Search, ChevronDown, ChevronRight } from "lucide-react";
import { fetchLogs, type LogEntry, type LogQuery } from "./log-server-actions";

const LEVEL_COLORS: Record<string, string> = {
  debug: "bg-gray-100 text-gray-600",
  info: "bg-blue-50 text-blue-700",
  warn: "bg-amber-50 text-amber-700",
  error: "bg-red-50 text-red-700",
};

const SERVICE_COLORS: Record<string, string> = {
  gateway: "bg-purple-50 text-purple-700",
  gtd: "bg-green-50 text-green-700",
  google: "bg-blue-50 text-blue-700",
  awareness: "bg-cyan-50 text-cyan-700",
};

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function LogRow({ log }: { log: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails =
    log.error_message || log.tool_name || log.duration_ms || log.metadata;

  return (
    <div className="border-b border-gray-100 last:border-0">
      <div
        className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 ${
          hasDetails ? "cursor-pointer" : ""
        }`}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        {hasDetails ? (
          expanded ? (
            <ChevronDown className="h-3 w-3 text-gray-400 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-gray-400 shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        <span className="text-[11px] text-gray-400 font-mono w-16 shrink-0">
          {formatTimestamp(log.timestamp)}
        </span>

        <span className="text-[10px] text-gray-300 w-10 shrink-0">
          {formatDate(log.timestamp)}
        </span>

        <Badge
          className={`text-[10px] px-1.5 py-0 font-medium ${
            LEVEL_COLORS[log.level] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {log.level}
        </Badge>

        <Badge
          className={`text-[10px] px-1.5 py-0 font-medium ${
            SERVICE_COLORS[log.service] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {log.service}
        </Badge>

        {log.tool_name && (
          <span className="text-xs text-gray-500 font-mono">
            {log.tool_name}
          </span>
        )}

        <span className="text-sm text-gray-700 truncate flex-1 min-w-0">
          {log.message}
        </span>

        {log.duration_ms !== undefined && (
          <span
            className={`text-[11px] font-mono shrink-0 ${
              log.duration_ms > 5000
                ? "text-red-500"
                : log.duration_ms > 1000
                ? "text-amber-500"
                : "text-gray-400"
            }`}
          >
            {log.duration_ms}ms
          </span>
        )}

        {log.success === false && (
          <Badge variant="destructive" className="text-[10px] px-1 py-0">
            FAIL
          </Badge>
        )}
      </div>

      {expanded && (
        <div className="px-10 pb-3 space-y-1">
          {log.error_message && (
            <p className="text-xs text-red-600 font-mono whitespace-pre-wrap">
              {log.error_message}
            </p>
          )}
          {log.user_id && (
            <p className="text-[11px] text-gray-400">
              user: {log.user_id}
            </p>
          )}
          {log.action && (
            <p className="text-[11px] text-gray-400">action: {log.action}</p>
          )}
          {log.metadata && Object.keys(log.metadata).length > 0 && (
            <pre className="text-[11px] text-gray-500 bg-gray-50 rounded p-2 overflow-x-auto">
              {JSON.stringify(log.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function LogViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [isPending, startTransition] = useTransition();

  // Filters
  const [index, setIndex] = useState<"app" | "audit">("app");
  const [service, setService] = useState("all");
  const [level, setLevel] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  const load = useCallback(() => {
    startTransition(async () => {
      const params: LogQuery = { index, limit: 200 };
      if (service !== "all") params.service = service;
      if (level !== "all") params.level = level;
      if (searchQuery) params.query = searchQuery;

      const result = await fetchLogs(params);
      setLogs(result.logs);
      setTotal(result.total);
    });
  }, [index, service, level, searchQuery]);

  useEffect(() => {
    load();
  }, [load]);

  const title = index === "audit" ? "Audit Log" : "Application Log";
  const subtitle = index === "audit"
    ? "All data mutations across MCPs"
    : "Tool calls, webhooks, and errors";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={load}
          disabled={isPending}
          aria-label="Refresh"
        >
          <RefreshCw
            className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="space-y-1">
          <span className="text-xs text-gray-500">Source</span>
          <Select value={index} onValueChange={(v) => setIndex(v as "app" | "audit")}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="app">App Log</SelectItem>
              <SelectItem value="audit">Audit Log</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <span className="text-xs text-gray-500">Service</span>
          <Select value={service} onValueChange={setService}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="gateway">Gateway</SelectItem>
              <SelectItem value="gtd">GTD</SelectItem>
              <SelectItem value="google">Calendar</SelectItem>
              <SelectItem value="awareness">Awareness</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <span className="text-xs text-gray-500">Level</span>
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-w-[200px] space-y-1">
          <span className="text-xs text-gray-500">Search</span>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              placeholder="Search messages..."
              className="pl-8 h-9"
            />
          </div>
        </div>

      </div>

      {/* Results count */}
      <div className="text-xs text-gray-400 mb-2">
        {isPending
          ? "Loading..."
          : `${logs.length} of ${total} entries`}
      </div>

      {/* Log list */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        {logs.length === 0 ? (
          <p className="p-6 text-sm text-gray-400 text-center">
            {isPending ? "Loading..." : "No log entries found"}
          </p>
        ) : (
          logs.map((log, i) => <LogRow key={`${log.timestamp}-${i}`} log={log} />)
        )}
      </div>
    </div>
  );
}
