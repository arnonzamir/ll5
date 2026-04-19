"use client";

import { useEffect, useState } from "react";
import { Search, Plus, Archive, MessageCircle, X } from "lucide-react";

export interface ConversationSummary {
  conversation_id: string;
  title: string | null;
  summary: string | null;
  created_at: string;
  archived_at: string | null;
  last_message_at: string | null;
  message_count: number;
  last_message?: string | null;
  unread_count?: string;
}

interface SearchResult {
  conversation_id: string;
  snippet: string;
  matched_at: string;
  title: string | null;
  summary: string | null;
  archived_at: string | null;
  last_message_at: string | null;
  message_count?: number;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function truncate(s: string | null | undefined, n = 80): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
  onClose?: () => void;
  refreshKey?: number;
}

export function ChatSidebar({ activeId, onSelect, onNewConversation, onClose, refreshKey }: Props) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/chat/conversations?limit=50");
        if (res.ok) {
          const data = await res.json();
          setConversations(data.conversations ?? []);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  // Debounced search
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/chat/conversations/search?q=${encodeURIComponent(q)}&limit=20`);
        if (res.ok) {
          const data = await res.json();
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
    <div className="flex flex-col h-full bg-white border-r border-gray-200">
      <div className="px-3 py-3 border-b border-gray-200 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">Conversations</span>
        <div className="flex items-center gap-1">
          <button
            className="p-1 text-gray-500 hover:text-gray-800 rounded"
            title="New conversation"
            onClick={onNewConversation}
          >
            <Plus className="w-4 h-4" />
          </button>
          {onClose && (
            <button
              className="p-1 text-gray-500 hover:text-gray-800 rounded md:hidden"
              title="Close"
              onClick={onClose}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="px-3 py-2 border-b border-gray-100">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="w-full pl-8 pr-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {results !== null ? (
          <div>
            <div className="px-3 pt-2 pb-1 text-xs uppercase tracking-wide text-gray-400">
              {searching ? "Searching…" : `Results (${results.length})`}
            </div>
            {results.map((r) => (
              <button
                key={r.conversation_id}
                onClick={() => onSelect(r.conversation_id)}
                className={`w-full text-left px-3 py-2 border-b border-gray-50 hover:bg-gray-50 ${
                  activeId === r.conversation_id ? "bg-primary/5" : ""
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-0.5">
                  {r.archived_at ? <Archive className="w-3 h-3" /> : <MessageCircle className="w-3 h-3" />}
                  <span>{formatTime(r.matched_at)}</span>
                </div>
                <div
                  className="text-sm text-gray-800 truncate"
                  // ES highlight snippets contain <em>…</em>; other sources are plain.
                  dangerouslySetInnerHTML={{ __html: r.snippet || "" }}
                />
              </button>
            ))}
            {!searching && results.length === 0 && (
              <p className="text-xs text-gray-400 text-center mt-6 px-3">No matches.</p>
            )}
          </div>
        ) : (
          <>
            <div className="px-3 pt-2 pb-1 text-xs uppercase tracking-wide text-gray-400">Active</div>
            {loading && <p className="text-xs text-gray-400 text-center mt-2">Loading…</p>}
            {!loading && active.length === 0 && (
              <p className="text-xs text-gray-400 text-center mt-2 px-3">None yet.</p>
            )}
            {active.map((c) => (
              <ConversationRow
                key={c.conversation_id}
                conv={c}
                active={activeId === c.conversation_id}
                onSelect={onSelect}
              />
            ))}

            {archived.length > 0 && (
              <>
                <div className="px-3 pt-3 pb-1 text-xs uppercase tracking-wide text-gray-400">Archived</div>
                {archived.map((c) => (
                  <ConversationRow
                    key={c.conversation_id}
                    conv={c}
                    active={activeId === c.conversation_id}
                    onSelect={onSelect}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ConversationRow({
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
      className={`w-full text-left px-3 py-2 border-b border-gray-50 hover:bg-gray-50 ${
        active ? "bg-primary/5" : ""
      }`}
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-sm font-medium text-gray-800 truncate flex items-center gap-1.5">
          {conv.archived_at && <Archive className="w-3 h-3 text-gray-400 shrink-0" />}
          {title}
        </span>
        <span className="text-[10px] text-gray-400 shrink-0 ml-2">{formatTime(conv.last_message_at)}</span>
      </div>
      <p className="text-xs text-gray-500 truncate">{preview}</p>
      <div className="text-[10px] text-gray-400 mt-0.5">{conv.message_count} msgs</div>
    </button>
  );
}
