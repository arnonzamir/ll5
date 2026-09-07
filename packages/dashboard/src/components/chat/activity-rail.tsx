"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, MessageSquareText, Inbox, X } from "lucide-react";
import {
  fetchActivity,
  type ActivityEntry,
} from "@/app/(user)/chat/activity-server-actions";
import { shortTime } from "@/lib/chat/format";

interface Props {
  /** Scroll the thread to a message; resolves false when it cannot be shown. */
  onJumpToMessage: (messageId: string, at: string) => Promise<boolean>;
  onClose?: () => void;
}

// DECISION-034 Section 4: the rail is the agent's self-initiated thinking, one
// entry per handled trigger, newest first. No badge, no push. While open it
// refreshes once a minute at most — the visibility refresh is throttled to the
// same interval; closed means unmounted, so nothing runs at all.
const POLL_MS = 60_000;
const PAGE = 40;
const THOUGHT_FOLD = 160;

const DECISION_CHIP: Record<NonNullable<ActivityEntry["decision"]>, { label: string; cls: string; title: string }> = {
  ping_now: { label: "pinged", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", title: "Sent to you now" },
  ping_later: { label: "later", cls: "bg-amber-50 text-amber-700 border-amber-200", title: "Deferred to a wake" },
  suppress: { label: "quiet", cls: "bg-surface-sunken text-ink-500 border-ink-300/50", title: "Nothing sent" },
};

function fmtCost(usd: number | null | undefined): string | null {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return null;
  if (usd === 0) return "free";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
}

/** Newest first, de-duplicated by id; `fresh` wins over `prev` on the same id. */
function mergeNewestFirst(fresh: ActivityEntry[], prev: ActivityEntry[]): ActivityEntry[] {
  const seen = new Set(fresh.map((e) => e.id));
  const out = [...fresh, ...prev.filter((e) => !seen.has(e.id))];
  out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return out;
}

export function ActivityRail({ onJumpToMessage, onClose }: Props) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  const lastFetchAt = useRef(0);

  const load = useCallback(async () => {
    lastFetchAt.current = Date.now();
    const res = await fetchActivity({ limit: PAGE });
    if (!alive.current) return;
    if (res.ok) {
      setEntries((prev) => mergeNewestFirst(res.entries, prev));
      setNextCursor((prev) => prev ?? res.next_cursor);
      setError(null);
    } else {
      // Keep the last good list on screen; the amber line says why it is stale.
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const h = setInterval(() => void load(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchAt.current >= POLL_MS) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      clearInterval(h);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const res = await fetchActivity({ limit: PAGE, cursor: nextCursor });
    if (!alive.current) return;
    if (res.ok) {
      setEntries((prev) => mergeNewestFirst(prev, res.entries));
      setNextCursor(res.next_cursor);
      setError(null);
    } else {
      setError(res.error);
    }
    setLoadingMore(false);
  }, [nextCursor, loadingMore]);

  const jump = useCallback(
    async (messageId: string, at: string) => {
      const ok = await onJumpToMessage(messageId, at);
      if (!ok) {
        setNote("That message is not in the open thread.");
        setTimeout(() => setNote(null), 4000);
      }
    },
    [onJumpToMessage],
  );

  return (
    <div className="flex flex-col h-full bg-surface-rail border-l border-ink-300/50">
      <div className="px-3 py-3 border-b border-ink-300/40 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide font-mono text-ink-500 flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5" />
          Activity
        </span>
        {onClose && (
          <button className="p-1 text-ink-500 hover:text-ink-900 rounded" title="Close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {error && (
        <p className="px-3 py-1.5 text-[11px] text-amber-800 bg-amber-50 border-b border-amber-200" role="status">
          Activity unavailable: {error}
        </p>
      )}
      {note && (
        <p className="px-3 py-1.5 text-[11px] text-ink-600 bg-surface-sunken border-b border-ink-300/40" role="status">
          {note}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && !error && <p className="text-xs text-ink-400 text-center mt-3">Loading…</p>}
        {!loading && entries.length === 0 && !error && (
          <p className="text-xs text-ink-400 text-center mt-6 px-3">
            Nothing yet. Each trigger the agent handles on its own shows up here.
          </p>
        )}
        {entries.map((e) => {
          const chip = e.decision ? DECISION_CHIP[e.decision] : null;
          const thought = e.thought ?? "";
          const long = thought.length > THOUGHT_FOLD;
          const open = expanded[e.id] === true;
          const cost = fmtCost(e.cost_usd);
          return (
            <div key={e.id} className="px-3 py-2 border-b border-ink-300/20 text-[12px]">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-mono text-ink-400 shrink-0" title={e.at}>
                  {shortTime(e.at)}
                </span>
                <span className="text-[10px] font-mono text-ink-400 shrink-0 uppercase">{e.trigger.kind}</span>
                <span className="text-ink-800 truncate flex-1" dir="auto" title={e.trigger.summary}>
                  {e.trigger.summary || "(no summary)"}
                </span>
              </div>

              {thought && (
                <button
                  type="button"
                  onClick={() => long && setExpanded((s) => ({ ...s, [e.id]: !open }))}
                  className={`mt-1 w-full text-left italic text-ink-500 leading-snug ${
                    long ? "hover:text-ink-700" : "cursor-default"
                  }`}
                  dir="auto"
                  title={long ? (open ? "Collapse" : "Expand") : undefined}
                >
                  <span className="text-ink-300 select-none mr-1">*</span>
                  {open || !long ? thought : thought.slice(0, THOUGHT_FOLD - 1) + "…"}
                </button>
              )}

              <div className="mt-1 flex items-center gap-2 flex-wrap">
                {chip && (
                  <span
                    className={`px-1.5 py-px rounded-full border text-[10px] font-mono ${chip.cls}`}
                    title={e.outcome?.deferral_ref ? `${chip.title} (${e.outcome.deferral_ref})` : chip.title}
                  >
                    {chip.label}
                  </span>
                )}
                {e.outcome?.class && (
                  <span className="text-[10px] font-mono text-ink-400" title="Delivery class">
                    {e.outcome.class}
                  </span>
                )}
                {e.reason && (
                  <span className="text-[11px] text-ink-500 truncate flex-1 min-w-0" dir="auto" title={e.reason}>
                    {e.reason}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {e.outcome?.message_id && (
                    <button
                      type="button"
                      onClick={() => void jump(e.outcome!.message_id!, e.at)}
                      className="flex items-center gap-1 text-[10px] font-mono text-primary hover:underline"
                      title="Show the message in the thread"
                    >
                      <MessageSquareText className="w-3 h-3" />
                      message
                    </button>
                  )}
                  {e.outcome?.tray_item_id && (
                    <span
                      className="flex items-center gap-1 text-[10px] font-mono text-ink-500"
                      title={`Tray item ${e.outcome.tray_item_id} (the tray lives in the Android app until Phase 3)`}
                    >
                      <Inbox className="w-3 h-3" />
                      tray
                    </span>
                  )}
                  {cost && <span className="text-[10px] font-mono text-ink-400/80">{cost}</span>}
                </span>
              </div>
            </div>
          );
        })}
        {nextCursor && !loading && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="w-full py-2 text-[11px] font-mono text-ink-500 hover:text-ink-800 disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load older"}
          </button>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-ink-300/30 text-[10px] text-ink-400 font-mono">
        {entries.length} entries · refreshes every 60 s while open
      </div>
    </div>
  );
}
