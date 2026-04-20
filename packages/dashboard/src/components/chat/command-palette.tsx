"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, MessageCircle, Plus, Search } from "lucide-react";
import type { ConversationSummary } from "@/lib/chat/types";
import { shortTime } from "@/lib/chat/format";

interface Action {
  key: string;
  label: string;
  hint?: string;
  onRun: () => void;
  group: "Commands" | "Conversations";
  icon?: React.ReactNode;
}

interface Props {
  open: boolean;
  onClose: () => void;
  activeId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onToggleSidebar: () => void;
}

/**
 * Minimal cmd+k palette — fuzzy filter over a fixed command list plus
 * the user's conversation list (fetched once when opened). No external
 * library — we have kbd and basic filter logic.
 */
export function CommandPalette({
  open,
  onClose,
  activeId,
  onSelectConversation,
  onNewConversation,
  onToggleSidebar,
}: Props) {
  const [query, setQuery] = useState("");
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    (async () => {
      try {
        const res = await fetch("/api/chat/conversations?limit=20");
        if (res.ok) {
          const data = (await res.json()) as { conversations?: ConversationSummary[] };
          setConvs(data.conversations ?? []);
        }
      } catch { /* noop */ }
    })();
  }, [open]);

  const commands: Action[] = useMemo(
    () => [
      {
        key: "new-conv",
        label: "New conversation",
        hint: "⌘N",
        group: "Commands",
        icon: <Plus className="w-3.5 h-3.5" />,
        onRun: () => { onClose(); onNewConversation(); },
      },
      {
        key: "toggle-sidebar",
        label: "Toggle conversation sidebar",
        hint: "⌘B",
        group: "Commands",
        icon: <Archive className="w-3.5 h-3.5" />,
        onRun: () => { onClose(); onToggleSidebar(); },
      },
    ],
    [onClose, onNewConversation, onToggleSidebar],
  );

  const convActions: Action[] = useMemo(
    () =>
      convs.map((c) => ({
        key: `conv-${c.conversation_id}`,
        label: c.title || (c.archived_at ? "(archived)" : "(untitled)"),
        hint: shortTime(c.last_message_at),
        group: "Conversations",
        icon: c.archived_at ? (
          <Archive className="w-3.5 h-3.5 text-ink-400" />
        ) : (
          <MessageCircle className="w-3.5 h-3.5 text-coach-500" />
        ),
        onRun: () => {
          onClose();
          onSelectConversation(c.conversation_id);
        },
      })),
    [convs, onClose, onSelectConversation],
  );

  const all = useMemo(() => [...commands, ...convActions], [commands, convActions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((a) => a.label.toLowerCase().includes(q) || a.key.toLowerCase().includes(q));
  }, [all, query]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/30 flex items-start justify-center pt-[10vh] px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl border border-ink-300/40 w-full max-w-[560px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + 1)); return; }
          if (e.key === "ArrowUp")   { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
          if (e.key === "Enter")     { e.preventDefault(); filtered[cursor]?.onRun(); return; }
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-300/30">
          <Search className="w-4 h-4 text-ink-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search conversations…"
            className="flex-1 bg-transparent outline-none text-[14px] text-ink-900 placeholder:text-ink-400"
          />
          <span className="text-[10px] text-ink-400 font-mono">esc</span>
        </div>
        <div className="max-h-[420px] overflow-y-auto py-1">
          {["Commands", "Conversations"].map((group) => {
            const inGroup = filtered.filter((a) => a.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-ink-400 font-mono">
                  {group}
                </div>
                {inGroup.map((a) => {
                  const globalIdx = filtered.indexOf(a);
                  const selected = globalIdx === cursor;
                  const isActive = a.key === `conv-${activeId}`;
                  return (
                    <button
                      key={a.key}
                      onMouseEnter={() => setCursor(globalIdx)}
                      onClick={a.onRun}
                      className={
                        "w-full text-left flex items-center gap-2 px-3 py-2 text-[13px] " +
                        (selected ? "bg-surface-sunken" : "hover:bg-surface-sunken/70")
                      }
                    >
                      {a.icon}
                      <span className="flex-1 truncate" dir="auto">
                        {a.label}
                        {isActive && (
                          <span className="ml-2 text-[10px] text-coach-700 font-mono uppercase tracking-wide">
                            current
                          </span>
                        )}
                      </span>
                      {a.hint && <span className="text-[11px] text-ink-400 font-mono">{a.hint}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-ink-400">No matches.</p>
          )}
        </div>
      </div>
    </div>
  );
}
