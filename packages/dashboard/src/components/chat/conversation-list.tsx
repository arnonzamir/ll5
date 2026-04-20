"use client";

import { useEffect, useState } from "react";
import { Archive, MessageCircle, Plus, Search, X } from "lucide-react";
import type { ConversationSummary, ConversationSearchResult } from "@/lib/chat/types";
import { shortTime, truncate } from "@/lib/chat/format";

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
  onClose?: () => void;
  refreshKey?: number;
}

export function ConversationList({
  activeId,
  onSelect,
  onNewConversation,
  onClose,
  refreshKey,
}: Props) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/chat/conversations?limit=50");
        if (res.ok) {
          const data = (await res.json()) as { conversations?: ConversationSummary[] };
          setConversations(data.conversations ?? []);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey, activeId]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/chat/conversations/search?q=${encodeURIComponent(q)}&limit=20`,
        );
        if (res.ok) {
          const data = (await res.json()) as { results?: ConversationSearchResult[] };
          setResults(data.results ?? []);
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query]);

  const active = conversations.filter((c) => !c.archived_at);
  const archived = conversations.filter((c) => c.archived_at);

  return (
    <div className="flex flex-col h-full bg-surface-rail border-r border-ink-300/50">
      <div className="px-3 py-3 border-b border-ink-300/40 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide font-mono text-ink-500">
          Conversations
        </span>
        <div className="flex items-center gap-1">
          <button
            className="p-1 text-ink-500 hover:text-ink-900 rounded"
            title="New conversation (⌘N)"
            onClick={onNewConversation}
          >
            <Plus className="w-4 h-4" />
          </button>
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
      </div>

      <div className="px-3 py-2 border-b border-ink-300/30">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-ink-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full pl-8 pr-2 py-1.5 text-xs border border-ink-300/60 rounded bg-white/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {results !== null ? (
          <div>
            <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-ink-400 font-mono">
              {searching ? "Searching…" : `Results (${results.length})`}
            </div>
            {results.map((r) => (
              <button
                key={r.conversation_id}
                onClick={() => onSelect(r.conversation_id)}
                className={`w-full text-left px-3 py-2 border-b border-ink-300/20 hover:bg-surface-sunken/70 ${
                  activeId === r.conversation_id ? "bg-surface-sunken" : ""
                }`}
              >
                <div className="flex items-center gap-1.5 text-[11px] text-ink-400 mb-0.5 font-mono">
                  {r.archived_at ? <Archive className="w-3 h-3" /> : <MessageCircle className="w-3 h-3" />}
                  <span>{shortTime(r.matched_at)}</span>
                </div>
                <div
                  className="text-sm text-ink-900 truncate"
                  dir="auto"
                  dangerouslySetInnerHTML={{ __html: r.snippet || "" }}
                />
              </button>
            ))}
            {!searching && results.length === 0 && (
              <p className="text-xs text-ink-400 text-center mt-6 px-3">No matches.</p>
            )}
          </div>
        ) : (
          <>
            <Section title="Active">
              {loading && <p className="text-xs text-ink-400 text-center mt-2">Loading…</p>}
              {!loading && active.length === 0 && (
                <p className="text-xs text-ink-400 text-center mt-2 px-3">None yet.</p>
              )}
              {active.map((c) => (
                <Row key={c.conversation_id} conv={c} active={activeId === c.conversation_id} onSelect={onSelect} />
              ))}
            </Section>
            {archived.length > 0 && (
              <Section title="Archived">
                {archived.map((c) => (
                  <Row key={c.conversation_id} conv={c} active={activeId === c.conversation_id} onSelect={onSelect} />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wide text-ink-400 font-mono">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  conv,
  active,
  onSelect,
}: {
  conv: ConversationSummary;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const title = conv.title || (conv.archived_at ? "(archived)" : "(untitled)");
  const preview = conv.summary ? conv.summary : truncate(conv.last_message, 80);
  return (
    <button
      onClick={() => onSelect(conv.conversation_id)}
      className={`w-full text-left px-3 py-2 border-b border-ink-300/20 hover:bg-surface-sunken/70 ${
        active ? "bg-surface-sunken" : ""
      }`}
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-sm font-medium text-ink-900 truncate flex items-center gap-1.5" dir="auto">
          {conv.archived_at && <Archive className="w-3 h-3 text-ink-400 shrink-0" />}
          {title}
        </span>
        <span className="text-[10px] text-ink-400 shrink-0 ml-2 font-mono">
          {shortTime(conv.last_message_at)}
        </span>
      </div>
      <p className="text-xs text-ink-500 truncate" dir="auto">{preview}</p>
      <div className="text-[10px] text-ink-400 mt-0.5 font-mono">{conv.message_count} msgs</div>
    </button>
  );
}
