"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, User as UserIcon, MapPin, Users, Tag, Sparkles } from "lucide-react";
import {
  fetchNarratives,
  type Narrative,
  type SubjectKind,
} from "@/app/(user)/narratives/narratives-server-actions";

interface Props {
  /** Currently open topic (its subject ref string), for highlight. */
  activeRef?: string | null;
  onSelect: (n: Narrative) => void;
  onClose?: () => void;
  /** Bump to force a refetch (e.g. after a jump-in). */
  refreshKey?: number;
}

type SortMode = "relevance" | "recency";
type KindFilter = "all" | SubjectKind;

const KIND_ICON: Record<SubjectKind, React.ComponentType<{ className?: string }>> = {
  person: UserIcon,
  place: MapPin,
  group: Users,
  topic: Tag,
};

const KIND_CHIPS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "topic", label: "Topics" },
  { key: "group", label: "Groups" },
  { key: "person", label: "People" },
];

// DECISION-028 #6: this poll was 9,350 of the 27,055 tool calls in the Aug–Sep
// baseline (one call every 45 s per open tab, limit 150) — more than the whole
// narrative loop. 5 min + refresh when the tab becomes visible again is plenty for
// a rail that re-ranks on a 20-minute consolidation cadence.
const POLL_MS = 300_000;
const RAIL_LIMIT = 60;

/** Age of the latest activity → a freshness dot color + short relative label. */
function freshness(iso?: string): { dot: string; label: string } {
  if (!iso) return { dot: "bg-ink-300", label: "" };
  const ageH = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (ageH < 6) return { dot: "bg-emerald-500", label: ageH < 1 ? "now" : `${Math.round(ageH)}h` };
  if (ageH < 48) return { dot: "bg-amber-500", label: `${Math.round(ageH)}h` };
  const ageD = ageH / 24;
  if (ageD < 14) return { dot: "bg-ink-400", label: `${Math.round(ageD)}d` };
  return { dot: "bg-ink-300", label: `${Math.round(ageD)}d` };
}

/**
 * Lightweight, live "active topics" rail — the consumer-facing surface of the
 * narrative substrate. Shows active narratives relevance-ranked (timeliness +
 * centrality), with kind filter + sort + search. Polls so it re-ranks itself as
 * the background consolidation loop folds in new activity.
 */
export function ActiveTopicsRail({ activeRef, onSelect, onClose, refreshKey }: Props) {
  const [items, setItems] = useState<Narrative[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortMode>("relevance");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const firstLoad = useRef(true);

  // Fetch all active narratives (sorted server-side); kind + search are applied
  // client-side so switching chips/typing is instant with no round-trip.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (firstLoad.current) setLoading(true);
      try {
        const data = await fetchNarratives({ status: "active", sort, limit: RAIL_LIMIT });
        if (!cancelled) setItems(data);
      } catch {
        /* keep last good list */
      } finally {
        if (!cancelled) { setLoading(false); firstLoad.current = false; }
      }
    }
    void load();
    const h = setInterval(load, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(h); };
  }, [sort, refreshKey]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((n) => {
      if (kind !== "all" && n.subject.kind !== kind) return false;
      if (q && !(n.title || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, kind, query]);

  return (
    <div className="flex flex-col h-full bg-surface-rail border-r border-ink-300/50">
      <div className="px-3 py-3 border-b border-ink-300/40 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide font-mono text-ink-500">
          Active topics
        </span>
        {onClose && (
          <button
            className="p-1 text-ink-500 hover:text-ink-900 rounded md:hidden"
            title="Close"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Controls: kind chips + sort + search */}
      <div className="px-3 py-2 border-b border-ink-300/30 space-y-2">
        <div className="flex items-center gap-1 flex-wrap">
          {KIND_CHIPS.map((c) => (
            <button
              key={c.key}
              onClick={() => setKind(c.key)}
              className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                kind === c.key
                  ? "bg-primary/10 border-primary/40 text-primary"
                  : "border-ink-300/50 text-ink-500 hover:text-ink-800"
              }`}
            >
              {c.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1 text-[11px]">
            <button
              onClick={() => setSort("relevance")}
              className={sort === "relevance" ? "text-primary font-medium" : "text-ink-400 hover:text-ink-700"}
              title="Most timely + central first"
            >
              Top
            </button>
            <span className="text-ink-300">·</span>
            <button
              onClick={() => setSort("recency")}
              className={sort === "recency" ? "text-primary font-medium" : "text-ink-400 hover:text-ink-700"}
              title="Most recent activity first"
            >
              Recent
            </button>
          </div>
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-ink-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter topics…"
            className="w-full pl-8 pr-2 py-1.5 text-xs border border-ink-300/60 rounded bg-white/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="text-xs text-ink-400 text-center mt-3">Loading…</p>}
        {!loading && visible.length === 0 && (
          <p className="text-xs text-ink-400 text-center mt-6 px-3">
            {items.length === 0 ? "No active topics yet." : "No topics match."}
          </p>
        )}
        {visible.map((n) => {
          const Icon = KIND_ICON[n.subject.kind] ?? Tag;
          const f = freshness(n.lastObservedAt);
          const refStr = `${n.subject.kind}:${n.subject.ref}`;
          const threads = n.openThreads?.length ?? 0;
          return (
            <button
              key={refStr}
              onClick={() => onSelect(n)}
              className={`w-full text-left px-3 py-2 border-b border-ink-300/20 hover:bg-surface-sunken/70 ${
                activeRef === refStr ? "bg-surface-sunken" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${f.dot}`} title="recency" />
                <Icon className="w-3.5 h-3.5 text-ink-400 shrink-0" />
                <span className="text-sm text-ink-900 truncate flex-1" dir="auto">
                  {n.title || "(untitled)"}
                </span>
                {f.label && <span className="text-[10px] text-ink-400 font-mono shrink-0">{f.label}</span>}
              </div>
              {(threads > 0 || n.sensitive) && (
                <div className="flex items-center gap-2 mt-0.5 pl-[18px] text-[10px] text-ink-400 font-mono">
                  {threads > 0 && <span>{threads} open</span>}
                  {n.sensitive && <span className="text-rose-400">sensitive</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-ink-300/30 text-[10px] text-ink-400 font-mono flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" />
        {visible.length} active · live
      </div>
    </div>
  );
}
