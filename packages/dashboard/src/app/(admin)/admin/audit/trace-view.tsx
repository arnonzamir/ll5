"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchTrace, type TraceEvent, type TraceField } from "./trace-server-actions";

const FIELDS: { value: TraceField; label: string }[] = [
  { value: "request_id", label: "request_id" },
  { value: "session_id", label: "session_id" },
  { value: "trace_id", label: "trace_id" },
];

// Recursively unwrap stringified JSON at any depth — MCP tool results nest their
// payload as a JSON STRING inside content[].text, so a single parse leaves an
// escaped mess.
function deepUnwrap(value: unknown): unknown {
  if (typeof value === "string") {
    const s = value.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        return deepUnwrap(JSON.parse(s));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(deepUnwrap);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepUnwrap(v);
    return out;
  }
  return value;
}

function pretty(json?: string): string {
  if (!json) return "";
  try {
    return JSON.stringify(deepUnwrap(JSON.parse(json)), null, 2);
  } catch {
    return json;
  }
}

function fmtTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export function TraceView() {
  const [field, setField] = useState<TraceField>("session_id");
  const [value, setValue] = useState("");
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [counts, setCounts] = useState({ app_log: 0, audit: 0 });
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const run = useCallback(async (f: TraceField, v: string) => {
    if (!v.trim()) return;
    setLoading(true);
    setRan(true);
    try {
      const r = await fetchTrace(f, v.trim(), 500);
      setEvents(r.events);
      setCounts(r.counts);
    } finally {
      setLoading(false);
    }
  }, []);

  // Deep-link: ?trace=<id>&field=<field>
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("trace");
    const f = (p.get("field") as TraceField) || "session_id";
    if (v) {
      setField(f);
      setValue(v);
      void run(f, v);
    }
  }, [run]);

  const traceId = (f: TraceField, v?: string) => {
    if (!v) return;
    setField(f);
    setValue(v);
    const url = new URL(window.location.href);
    url.searchParams.set("trace", v);
    url.searchParams.set("field", f);
    window.history.replaceState(null, "", url.toString());
    void run(f, v);
  };

  const idLink = (f: TraceField, v?: string) =>
    v ? (
      <button
        onClick={() => traceId(f, v)}
        className="font-mono text-xs text-blue-600 hover:underline"
        title={`Follow ${f}=${v}`}
      >
        {v.length > 16 ? v.slice(0, 16) + "…" : v}
      </button>
    ) : (
      <span className="text-gray-400">—</span>
    );

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          traceId(field, value);
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <select
          value={field}
          onChange={(e) => setField(e.target.value as TraceField)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          {FIELDS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="paste a request_id / session_id / trace_id"
          className="min-w-[320px] flex-1 rounded border border-gray-300 px-3 py-1 font-mono text-sm"
        />
        <button type="submit" className="rounded bg-blue-600 px-4 py-1 text-sm font-medium text-white hover:bg-blue-700">
          Trace
        </button>
      </form>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {ran && !loading && (
        <p className="text-sm text-gray-500">
          {events.length} events — {counts.app_log} app_log, {counts.audit} audit
          {events.length === 0 && " (nothing correlated to that id)"}
        </p>
      )}

      <ol className="space-y-1">
        {events.map((ev) => {
          const isTool = ev.kind === "tool_call";
          const key = ev.source_index + ":" + ev._id;
          const open = !!expanded[key];
          return (
            <li
              key={key}
              className={`rounded border px-3 py-2 text-sm ${
                ev.success === false ? "border-red-300 bg-red-50" : "border-gray-200 bg-white"
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs text-gray-500">{fmtTime(ev.timestamp)}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    ev.source_index === "audit" ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {ev.kind || ev.source_index}
                </span>
                {ev.service && <span className="text-xs text-gray-500">{ev.service}</span>}
                <span className="font-medium">
                  {ev.tool_name || ev.action || ev.entity_type || ev.message?.slice(0, 80) || "—"}
                </span>
                {ev.summary && <span className="text-xs text-gray-600">{ev.summary}</span>}
                {typeof ev.duration_ms === "number" && (
                  <span className="text-xs text-gray-400">{ev.duration_ms}ms</span>
                )}
                {ev.success === false && <span className="text-xs font-semibold text-red-600">FAILED</span>}
                {isTool && (
                  <button
                    onClick={() => setExpanded((s) => ({ ...s, [key]: !open }))}
                    className="ml-auto text-xs text-blue-600 hover:underline"
                  >
                    {open ? "hide I/O" : "show I/O"}
                  </button>
                )}
              </div>

              <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-gray-400">
                <span>req {idLink("request_id", ev.request_id)}</span>
                <span>sess {idLink("session_id", ev.session_id)}</span>
                <span>trace {idLink("trace_id", ev.trace_id)}</span>
              </div>

              {isTool && open && (
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase text-gray-500">args</div>
                    <pre className="max-h-64 overflow-auto rounded bg-gray-900 p-2 text-[11px] text-gray-100">
                      {pretty(ev.args) || "—"}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase text-gray-500">result</div>
                    <pre className="max-h-64 overflow-auto rounded bg-gray-900 p-2 text-[11px] text-gray-100">
                      {ev.error_message ? "ERROR: " + ev.error_message : pretty(ev.result) || "—"}
                    </pre>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
