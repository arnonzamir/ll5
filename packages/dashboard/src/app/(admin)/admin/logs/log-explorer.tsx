"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  RefreshCw,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchLogs,
  fetchLogById,
  fetchEntityDetails,
  type LogQuery,
  type LogResult,
} from "./log-server-actions";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ColumnDef {
  field: string;
  label: string;
  width?: string;
}

export interface LogExplorerProps {
  index: string;
  title: string;
  subtitle: string;
  columns: ColumnDef[];
  facetFields: string[];
  searchFields?: string[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TIME_RANGES = ["15m", "1h", "4h", "1d", "7d"] as const;

const LEVEL_COLORS: Record<string, string> = {
  debug: "bg-gray-100 text-gray-600 border-gray-200",
  info: "bg-blue-50 text-blue-700 border-blue-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
};

const SERVICE_COLORS: Record<string, string> = {
  gtd: "bg-green-50 text-green-700 border-green-200",
  awareness: "bg-cyan-50 text-cyan-700 border-cyan-200",
  gateway: "bg-purple-50 text-purple-700 border-purple-200",
  knowledge: "bg-orange-50 text-orange-700 border-orange-200",
  messaging: "bg-pink-50 text-pink-700 border-pink-200",
  health: "bg-red-50 text-red-700 border-red-200",
  google: "bg-blue-50 text-blue-700 border-blue-200",
};

/* ------------------------------------------------------------------ */
/*  Utility helpers                                                    */
/* ------------------------------------------------------------------ */

function formatTime(ts: unknown): string {
  if (typeof ts !== "string") return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatFullDate(ts: unknown): string {
  if (typeof ts !== "string") return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(ms: unknown): string {
  if (typeof ms !== "number") return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function durationColor(ms: unknown): string {
  if (typeof ms !== "number") return "text-gray-400";
  if (ms > 5000) return "text-red-500";
  if (ms > 1000) return "text-amber-500";
  return "text-green-600";
}

function getBadgeColor(field: string, value: string): string {
  if (field === "level") return LEVEL_COLORS[value] ?? "bg-gray-100 text-gray-600 border-gray-200";
  if (field === "service" || field === "source") return SERVICE_COLORS[value] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return "bg-gray-100 text-gray-600 border-gray-200";
}

/* ------------------------------------------------------------------ */
/*  CopyButton                                                         */
/* ------------------------------------------------------------------ */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center p-0.5 rounded hover:bg-gray-200 transition-colors"
      title="Copy"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3 text-gray-400" />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  EntityLink (reused from old log-viewer)                            */
/* ------------------------------------------------------------------ */

function EntityLink({ entityType, entityId }: { entityType: string; entityId: string }) {
  const [details, setDetails] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  async function handleHover() {
    setShowTooltip(true);
    if (details || loading) return;
    setLoading(true);
    const result = await fetchEntityDetails(entityType, entityId);
    setDetails(result);
    setLoading(false);
  }

  return (
    <div className="relative inline-block">
      <p
        className="text-xs text-blue-500 cursor-pointer underline decoration-dotted"
        onMouseEnter={handleHover}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {entityType}/{entityId.length > 20 ? entityId.slice(0, 20) + "..." : entityId}
      </p>
      {showTooltip && (
        <div className="absolute left-0 top-5 z-50 bg-white border border-gray-200 rounded-md shadow-lg p-3 max-w-md max-h-48 overflow-auto text-xs">
          {loading ? (
            <p className="text-gray-400">Loading...</p>
          ) : details ? (
            <pre className="text-[11px] text-gray-600 whitespace-pre-wrap">
              {JSON.stringify(details, null, 2).slice(0, 500)}
            </pre>
          ) : (
            <p className="text-gray-400">No details found</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  FacetSection                                                       */
/* ------------------------------------------------------------------ */

function FacetSection({
  field,
  buckets,
  selected,
  onToggle,
  onOnly,
}: {
  field: string;
  buckets: Array<{ key: string; count: number }>;
  selected: string[];
  onToggle: (field: string, value: string) => void;
  onOnly: (field: string, value: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const visibleBuckets = showAll ? buckets : buckets.slice(0, 10);
  const hasMore = buckets.length > 10;

  return (
    <div className="mb-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5 hover:text-gray-700"
      >
        <span>{field}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>

      {expanded && (
        <div className="space-y-0.5">
          {visibleBuckets.map((b) => (
            <label
              key={b.key}
              className="flex items-center gap-2 py-0.5 px-1 rounded cursor-pointer hover:bg-gray-50 group"
            >
              <Checkbox
                checked={selected.includes(b.key)}
                onCheckedChange={() => onToggle(field, b.key)}
                className="h-3.5 w-3.5"
              />
              <span className="text-xs text-gray-700 truncate flex-1">{b.key}</span>
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOnly(field, b.key); }}
                className="text-[10px] text-blue-500 hover:text-blue-700 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                only
              </button>
              <span className="text-[10px] text-gray-400 tabular-nums">{b.count.toLocaleString()}</span>
            </label>
          ))}
          {hasMore && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-[10px] text-blue-500 hover:text-blue-700 px-1 mt-1"
            >
              {showAll ? "Show less" : `Show all (${buckets.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DetailPanel                                                        */
/* ------------------------------------------------------------------ */

function DetailPanel({
  doc,
  index,
  onClose,
}: {
  doc: Record<string, unknown>;
  index: string;
  onClose: () => void;
}) {
  const isAudit = index === "ll5_audit_log";
  const entries = Object.entries(doc).filter(([k]) => k !== "_id");

  // Sort: common fields first, metadata last
  const priority = ["timestamp", "service", "source", "level", "action", "tool_name", "entity_type", "entity_id", "message", "summary", "user_id", "username", "duration_ms", "success"];
  entries.sort((a, b) => {
    const ai = priority.indexOf(a[0]);
    const bi = priority.indexOf(b[0]);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    if (a[0] === "metadata") return 1;
    if (b[0] === "metadata") return -1;
    return a[0].localeCompare(b[0]);
  });

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-96 bg-white border-l border-gray-200 shadow-xl z-50 overflow-y-auto animate-in slide-in-from-right duration-200">
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">Log Detail</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 transition-colors"
          >
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          {/* Document ID */}
          {doc._id != null && (
            <div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-0.5">ID</div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono text-gray-600 break-all">{String(doc._id)}</span>
                <CopyButton text={String(doc._id)} />
              </div>
            </div>
          )}

          {entries.map(([key, value]) => {
            // Skip null/undefined
            if (value === null || value === undefined) return null;

            const isMetadata = key === "metadata";
            const isError = key === "error_message";
            const isId = key === "entity_id" || key === "user_id";
            const isTimestamp = key === "timestamp";

            return (
              <div key={key}>
                <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-0.5">
                  {key.replace(/_/g, " ")}
                </div>

                {isMetadata && typeof value === "object" ? (
                  <pre className="text-xs font-mono text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-64">
                    {JSON.stringify(value, null, 2)}
                  </pre>
                ) : isError ? (
                  <p className="text-xs font-mono text-red-600 whitespace-pre-wrap">{String(value)}</p>
                ) : isId ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono text-gray-600 break-all">{String(value)}</span>
                    <CopyButton text={String(value)} />
                  </div>
                ) : isTimestamp ? (
                  <span className="text-xs font-mono text-gray-600">{formatFullDate(value)}</span>
                ) : typeof value === "boolean" ? (
                  <Badge className={value ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}>
                    {String(value)}
                  </Badge>
                ) : (
                  <span className="text-xs text-gray-700 break-words">{String(value)}</span>
                )}

                {/* Entity link for audit logs */}
                {key === "entity_id" && isAudit && doc.entity_type != null && (
                  <div className="mt-1">
                    <EntityLink entityType={String(doc.entity_type)} entityId={String(value)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  LogExplorer — main component                                       */
/* ------------------------------------------------------------------ */

export function LogExplorer({
  index,
  title,
  subtitle,
  columns,
  facetFields,
}: LogExplorerProps) {
  // State
  const [timeRange, setTimeRange] = useState<string>("1h");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [sortField, setSortField] = useState("timestamp");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const [result, setResult] = useState<LogResult>({ logs: [], total: 0, facets: {} });
  const [facetCache, setFacetCache] = useState<Record<string, Array<{ key: string; count: number }>>>({});
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailDoc, setDetailDoc] = useState<Record<string, unknown> | null>(null);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active filter pills
  const activeFilters = Object.entries(filters).flatMap(([field, values]) =>
    values.map((v) => ({ field, value: v }))
  );

  // Load logs
  const load = useCallback(async (append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    const params: LogQuery = {
      index,
      search,
      timeRange,
      filters,
      facetFields,
      sortField,
      sortOrder,
      limit: 100,
      offset: append ? result.logs.length : 0,
    };

    const data = await fetchLogs(params);

    if (append) {
      setResult((prev) => ({
        logs: [...prev.logs, ...data.logs],
        total: data.total,
        facets: data.facets,
      }));
    } else {
      setResult(data);
    }

    // Update facet cache (avoid flicker by only updating after fetch)
    if (Object.keys(data.facets).length > 0) {
      setFacetCache(data.facets);
    }

    setLoading(false);
    setLoadingMore(false);
  }, [index, search, timeRange, filters, facetFields, sortField, sortOrder, result.logs.length]);

  // Fetch on filter changes
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, search, timeRange, filters, facetFields, sortField, sortOrder]);

  // Debounced search
  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearch(value);
    }, 300);
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      setSearch(searchInput);
    }
  }

  function clearSearch() {
    setSearchInput("");
    setSearch("");
  }

  // Toggle facet filter
  function toggleFacet(field: string, value: string) {
    setFilters((prev) => {
      const current = prev[field] ?? [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      const updated = { ...prev };
      if (next.length === 0) {
        delete updated[field];
      } else {
        updated[field] = next;
      }
      return updated;
    });
  }

  // "Only" — select exactly one value, deselect all others in this facet
  function onlyFacet(field: string, value: string) {
    setFilters((prev) => ({ ...prev, [field]: [value] }));
  }

  function removeFilter(field: string, value: string) {
    toggleFacet(field, value);
  }

  // Toggle sort
  function handleSort(field: string) {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  }

  // Open detail panel
  async function openDetail(id: string) {
    setSelectedId(id);
    const doc = await fetchLogById(index, id);
    if (doc) {
      setDetailDoc(doc);
    }
  }

  function closeDetail() {
    setSelectedId(null);
    setDetailDoc(null);
  }

  // Render cell
  function renderCell(field: string, value: unknown) {
    if (value === null || value === undefined) return <span className="text-gray-300">—</span>;

    if (field === "timestamp") {
      return (
        <span className="font-mono text-[11px] text-gray-600" title={formatFullDate(value)}>
          {formatTime(value)}
        </span>
      );
    }

    if (field === "level" || field === "service" || field === "source" || field === "action") {
      return (
        <Badge className={cn("text-[10px] px-1.5 py-0 font-medium border", getBadgeColor(field, String(value)))}>
          {String(value)}
        </Badge>
      );
    }

    if (field === "duration_ms") {
      return (
        <span className={cn("font-mono text-[11px]", durationColor(value))}>
          {formatDuration(value)}
        </span>
      );
    }

    if (field === "entity_id") {
      const str = String(value);
      return (
        <span className="font-mono text-[11px] text-gray-600" title={str}>
          {str.length > 8 ? str.slice(0, 8) + "..." : str}
        </span>
      );
    }

    if (field === "message" || field === "summary") {
      return (
        <span className="text-xs text-gray-700 truncate block max-w-full">
          {String(value)}
        </span>
      );
    }

    if (field === "success") {
      if (value === false) {
        return <Badge variant="destructive" className="text-[10px] px-1 py-0">FAIL</Badge>;
      }
      return null;
    }

    return <span className="text-xs text-gray-600 truncate block">{String(value)}</span>;
  }

  // Facets to display — use cache to prevent flicker
  const displayFacets = Object.keys(result.facets).length > 0 ? result.facets : facetCache;

  const canLoadMore = result.logs.length < result.total;

  return (
    <div className="space-y-3">
      {/* A. Header + Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Time range pills */}
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
            {TIME_RANGES.map((tr) => (
              <button
                key={tr}
                onClick={() => setTimeRange(tr)}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                  timeRange === tr
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                )}
              >
                {tr}
              </button>
            ))}
          </div>

          {/* Refresh */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => load()}
            disabled={loading}
            aria-label="Refresh"
            className="h-8 w-8"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* B. Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          value={searchInput}
          onChange={(e) => handleSearchInput(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search logs..."
          className="pl-9 pr-9 h-9"
        />
        {searchInput && (
          <button
            onClick={clearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-100"
          >
            <X className="h-3.5 w-3.5 text-gray-400" />
          </button>
        )}
      </div>

      {/* Active filter pills */}
      {activeFilters.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {activeFilters.map((f) => (
            <button
              key={`${f.field}:${f.value}`}
              onClick={() => removeFilter(f.field, f.value)}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium hover:bg-blue-100 transition-colors"
            >
              {f.field}: {f.value}
              <X className="h-3 w-3" />
            </button>
          ))}
          <button
            onClick={() => setFilters({})}
            className="text-xs text-gray-500 hover:text-gray-700 px-1"
          >
            Clear all
          </button>
        </div>
      )}

      {/* C. Main area */}
      <div className="flex gap-4">
        {/* C1. Facets sidebar */}
        <div className="hidden lg:block w-52 shrink-0">
          {facetFields.map((field) => (
            <FacetSection
              key={field}
              field={field}
              buckets={displayFacets[field] ?? []}
              selected={filters[field] ?? []}
              onToggle={toggleFacet}
              onOnly={onlyFacet}
            />
          ))}
        </div>

        {/* C2. Log table */}
        <div className="flex-1 min-w-0">
          {/* Result count */}
          <div className="text-xs text-gray-400 mb-2">
            {loading ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading...
              </span>
            ) : (
              `Showing ${result.logs.length.toLocaleString()} of ${result.total.toLocaleString()}`
            )}
          </div>

          {/* Table */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden relative">
            {/* Loading overlay */}
            {loading && result.logs.length > 0 && (
              <div className="absolute inset-0 bg-white/60 z-10 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              </div>
            )}

            {/* Header */}
            <div className="flex items-center bg-gray-50 border-b border-gray-200 px-3 py-1.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              {columns.map((col) => (
                <button
                  key={col.field}
                  onClick={() => handleSort(col.field)}
                  className={cn(
                    "text-left hover:text-gray-700 transition-colors flex items-center gap-0.5 shrink-0",
                    col.width ?? "flex-1 min-w-0"
                  )}
                >
                  {col.label}
                  {sortField === col.field && (
                    <span className="text-blue-500">
                      {sortOrder === "desc" ? " \u2193" : " \u2191"}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Rows */}
            {result.logs.length === 0 && !loading ? (
              <p className="p-6 text-sm text-gray-400 text-center">
                No log entries found
              </p>
            ) : (
              result.logs.map((hit) => (
                <div
                  key={hit._id}
                  onClick={() => openDetail(hit._id)}
                  className={cn(
                    "flex items-center px-3 py-1.5 border-b border-gray-50 cursor-pointer transition-colors text-xs",
                    selectedId === hit._id
                      ? "bg-blue-50"
                      : "hover:bg-gray-50"
                  )}
                >
                  {columns.map((col) => (
                    <div
                      key={col.field}
                      className={cn(
                        "shrink-0 overflow-hidden",
                        col.width ?? "flex-1 min-w-0"
                      )}
                    >
                      {renderCell(col.field, hit._source[col.field])}
                    </div>
                  ))}
                </div>
              ))
            )}

            {/* Load more */}
            {canLoadMore && !loading && (
              <div className="px-3 py-2 border-t border-gray-100 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => load(true)}
                  disabled={loadingMore}
                  className="text-xs"
                >
                  {loadingMore ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    `Load more (${(result.total - result.logs.length).toLocaleString()} remaining)`
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* C3. Detail panel */}
      {selectedId && detailDoc && (
        <DetailPanel doc={detailDoc} index={index} onClose={closeDetail} />
      )}
    </div>
  );
}
