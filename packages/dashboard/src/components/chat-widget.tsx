"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Ellipsis,
  ImagePlus,
  LayoutList,
  MessageSquareReply,
  Send,
  ShieldAlert,
  SmilePlus,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  X,
  CircleHelp,
  type LucideIcon,
} from "lucide-react";
import { ChatSidebar } from "./chat-sidebar";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Attachment {
  type: string;
  url: string;
  filename?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  status?: string;
  created_at: string;
  reply_to_id?: string | null;
  reaction?: string | null;
  display_compact?: boolean;
  metadata?: {
    attachments?: Attachment[];
    kind?: string;
    [key: string]: unknown;
  };
}

type Reaction = "acknowledge" | "reject" | "agree" | "disagree" | "confused" | "thinking";

const REACTION_ICONS: Record<Reaction, LucideIcon> = {
  acknowledge: Check,
  reject: X,
  agree: ThumbsUp,
  disagree: ThumbsDown,
  confused: CircleHelp,
  thinking: Ellipsis,
};

const REACTION_LABELS: Record<Reaction, string> = {
  acknowledge: "Acknowledge",
  reject: "Reject",
  agree: "Agree",
  disagree: "Disagree",
  confused: "Confused",
  thinking: "Thinking",
};

const REACTION_ORDER: Reaction[] = [
  "acknowledge",
  "agree",
  "disagree",
  "reject",
  "confused",
  "thinking",
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function MessageStatus({ status }: { status?: string }) {
  switch (status) {
    case "pending":
      return <Check className="w-3 h-3 text-gray-400" />;
    case "processing":
      return <CheckCheck className="w-3 h-3 text-blue-500" />;
    case "delivered":
      return <CheckCheck className="w-3 h-3 text-blue-500" />;
    case "failed":
      return <AlertCircle className="w-3 h-3 text-red-500" />;
    default:
      return null;
  }
}

function TypingIndicator() {
  return (
    <div className="mr-auto flex gap-1 px-3 py-2 bg-gray-100 rounded-2xl rounded-bl-sm">
      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
    </div>
  );
}

function uploadsUrl(url: string): string {
  return `/api/uploads${url.replace("/uploads", "")}`;
}

/** Pick the lead icon for a compact system row based on content heuristics. */
function compactIcon(m: Message): LucideIcon {
  const c = (m.content || "").toLowerCase();
  if (c.includes("[scheduler]") || c.includes("heartbeat") || c.includes("briefing")) return Clock;
  if (c.includes("alert") || c.includes("unhealthy") || c.includes("failed")) return ShieldAlert;
  if (c.includes("[tool") || c.includes("tool result")) return Wrench;
  if (c.includes("[conversation")) return Archive;
  return LayoutList;
}

/** True if two messages are close enough in time to visually group. */
function closeInTime(a: Message, b: Message, windowSec = 60): boolean {
  const ta = new Date(a.created_at).getTime();
  const tb = new Date(b.created_at).getTime();
  return Math.abs(tb - ta) <= windowSec * 1000;
}

// ---------------------------------------------------------------------------
// New-conversation dialog
// ---------------------------------------------------------------------------

function NewConversationDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (summary: string) => void;
}) {
  const [summary, setSummary] = useState("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-800 mb-2">Start a new conversation?</h3>
        <p className="text-xs text-gray-600 mb-3">
          The current thread is archived and a fresh one opens. Your assistant&apos;s memory is not
          cleared — only the visible scrollback resets. Add a short note for yourself (optional).
        </p>
        <textarea
          rows={4}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="3–6 lines: topics, decisions, open threads…"
          className="w-full text-sm border border-gray-300 rounded p-2 focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(summary.trim())}
            className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary/90"
          >
            Start new
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reaction popover
// ---------------------------------------------------------------------------

function ReactionPicker({
  onPick,
  onClose,
}: {
  onPick: (r: Reaction) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute z-30 bottom-full mb-1 bg-white rounded-lg shadow-lg border border-gray-200 px-1.5 py-1 flex gap-0.5">
        {REACTION_ORDER.map((r) => {
          const Icon = REACTION_ICONS[r];
          return (
            <button
              key={r}
              title={REACTION_LABELS[r]}
              onClick={() => onPick(r)}
              className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
            >
              <Icon className="w-4 h-4" />
            </button>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Compact row (single system event) + collapsible group band
// ---------------------------------------------------------------------------

function CompactRow({ m }: { m: Message }) {
  const isThinking = m.metadata?.kind === "thinking";
  if (isThinking) {
    return (
      <div className="flex items-start gap-2 py-0.5 px-1 text-xs text-gray-400 italic">
        <span className="text-gray-300 shrink-0 select-none">*</span>
        <span className="flex-1 leading-snug whitespace-pre-wrap break-words">{m.content ?? ""}</span>
      </div>
    );
  }
  const Icon = compactIcon(m);
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="flex items-start gap-2 py-0.5 px-1 text-xs text-gray-500 font-mono">
      <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5 text-gray-400" />
      <span className="flex-1 truncate leading-snug">{m.content ?? ""}</span>
      <span className="text-[10px] text-gray-400 shrink-0">{time}</span>
    </div>
  );
}

function CompactGroup({ items }: { items: Message[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 1) return <CompactRow m={items[0]} />;
  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-gray-400 hover:text-gray-600 py-0.5"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span>{items.length} system events</span>
      </button>
      {expanded && (
        <div className="ml-3 border-l border-gray-100 pl-2">
          {items.map((m) => (
            <CompactRow key={m.id} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubble (with reply quote, reactions, hover actions)
// ---------------------------------------------------------------------------

function ReplyQuote({ parent }: { parent: Message }) {
  const img = parent.metadata?.attachments?.find((a) => a.type === "image");
  return (
    <div className="mb-1 rounded border-l-2 border-gray-300 bg-gray-50 pl-2 pr-2 py-1 flex gap-2 items-start max-w-full">
      {img && (
        <img
          src={uploadsUrl(img.url)}
          alt=""
          className="w-8 h-8 object-cover rounded shrink-0"
          loading="lazy"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-gray-400">
          {parent.role === "user" ? "You" : "Assistant"}
        </div>
        <div className="text-xs text-gray-600 truncate">
          {parent.content ? parent.content.split("\n").slice(0, 2).join(" ").slice(0, 120) : img ? "[image]" : ""}
        </div>
      </div>
    </div>
  );
}

function ReactionStrip({
  reactions,
  onToggle,
}: {
  reactions: Message[];
  onToggle: (msg: Message) => void;
}) {
  // Group reactions by type to show count.
  const counts = reactions.reduce<Record<string, { count: number; byMe?: Message }>>((acc, r) => {
    const key = r.reaction!;
    acc[key] ||= { count: 0 };
    acc[key].count++;
    if (r.role === "user") acc[key].byMe = r;
    return acc;
  }, {});
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  return (
    <div className="flex gap-1 mt-1 flex-wrap">
      {entries.map(([rxn, { count, byMe }]) => {
        const Icon = REACTION_ICONS[rxn as Reaction];
        if (!Icon) return null;
        return (
          <button
            key={rxn}
            onClick={() => byMe && onToggle(byMe)}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border ${
              byMe
                ? "border-primary/40 text-primary bg-primary/5"
                : "border-gray-200 text-gray-500"
            } ${byMe ? "hover:bg-primary/10" : ""}`}
            title={`${REACTION_LABELS[rxn as Reaction]}${byMe ? " (click to remove)" : ""}`}
          >
            <Icon className="w-3 h-3" />
            {count > 1 && <span>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

interface BubbleProps {
  m: Message;
  parent: Message | undefined;
  reactions: Message[];
  onReply: (m: Message) => void;
  onReact: (m: Message, rxn: Reaction) => void;
  onRemoveReaction: (reactionMsg: Message) => void;
}

function MessageBubble({ m, parent, reactions, onReply, onReact, onRemoveReaction }: BubbleProps) {
  const [showPicker, setShowPicker] = useState(false);
  const isUser = m.role === "user";
  const images = m.metadata?.attachments?.filter((a) => a.type === "image") ?? [];
  const isSummary = m.metadata?.kind === "conversation_summary";

  return (
    <div className={`group flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div className="relative max-w-[85%]">
        {/* Hover action bar */}
        <div
          className={`absolute ${isUser ? "-left-[88px]" : "-right-[88px]"} top-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity`}
        >
          <button
            onClick={() => onReply(m)}
            className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
            title="Reply"
          >
            <MessageSquareReply className="w-3.5 h-3.5" />
          </button>
          <div className="relative">
            <button
              onClick={() => setShowPicker((v) => !v)}
              className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
              title="React"
            >
              <SmilePlus className="w-3.5 h-3.5" />
            </button>
            {showPicker && (
              <ReactionPicker
                onPick={(r) => {
                  setShowPicker(false);
                  onReact(m, r);
                }}
                onClose={() => setShowPicker(false)}
              />
            )}
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(m.content ?? "")}
            className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
            title="Copy"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Bubble */}
        <div
          className={`px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
            isUser
              ? "bg-primary text-white rounded-br-sm"
              : isSummary
                ? "bg-amber-50 text-gray-800 border border-amber-200 rounded-bl-sm"
                : "bg-gray-100 text-gray-900 rounded-bl-sm"
          }`}
        >
          {isSummary && (
            <div className="text-[10px] uppercase tracking-wide text-amber-700 mb-1">
              Conversation summary
            </div>
          )}
          {parent && <ReplyQuote parent={parent} />}
          {images.map((att, i) => (
            <img
              key={i}
              src={uploadsUrl(att.url)}
              alt={att.filename || "Image"}
              className="max-w-full rounded-lg mb-1 cursor-pointer"
              style={{ maxHeight: "300px" }}
              onClick={() => window.open(uploadsUrl(att.url), "_blank")}
              loading="lazy"
            />
          ))}
          {m.content}
        </div>

        <ReactionStrip
          reactions={reactions}
          onToggle={onRemoveReaction}
        />
      </div>
      {isUser && (
        <div className="mt-0.5 mr-1">
          <MessageStatus status={m.status} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export function ChatWidget() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [sidebarKey, setSidebarKey] = useState(0);
  const seenIds = useRef(new Set<string>());
  const pendingIdMap = useRef(new Map<string, string>());
  const messagesEnd = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingImage, setPendingImage] = useState<{ file: File; preview: string } | null>(null);

  const scrollToBottom = () => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  };
  useEffect(scrollToBottom, [messages]);

  // ---- Load active conversation on mount -------------------------------
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/chat/conversations/active");
        if (res.ok) {
          const data = await res.json();
          if (data.conversation_id) setConvId(data.conversation_id);
        }
      } catch (err) {
        console.error("[chat] Failed to load active conversation:", err);
      }
      setInitialized(true);
    })();
  }, []);

  // ---- Load message history when conversation changes -----------------
  useEffect(() => {
    if (!convId) return;
    (async () => {
      try {
        const res = await fetch(`/api/chat/messages?conversation_id=${convId}&limit=200`);
        if (!res.ok) return;
        const data = await res.json();
        seenIds.current.clear();
        const loaded: Message[] = [];
        for (const m of data.messages ?? []) {
          seenIds.current.add(m.id);
          loaded.push(m);
        }
        setMessages(loaded);
        setReplyTo(null);
      } catch (err) {
        console.error("[chat] history load failed:", err);
      }
    })();
  }, [convId]);

  // ---- SSE subscription ------------------------------------------------
  useEffect(() => {
    const es = new EventSource("/api/chat/listen");

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "connected" || data.type === "error") return;

        // Conversation lifecycle — server archived or created one.
        if (data.type === "conversation_archived" || data.type === "conversation_created") {
          // Refresh sidebar. If we were viewing the archived convo, fetch
          // the new active and switch to it.
          setSidebarKey((k) => k + 1);
          if (data.type === "conversation_archived" && data.conversation_id === convId) {
            (async () => {
              try {
                const res = await fetch("/api/chat/conversations/active");
                if (res.ok) {
                  const j = await res.json();
                  if (j.conversation_id) setConvId(j.conversation_id);
                }
              } catch {
                /* noop */
              }
            })();
          }
          return;
        }

        if (data.conversation_id && data.conversation_id !== convId) return;

        if (data.event === "status_update") {
          const tempId = pendingIdMap.current.get(data.id);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === data.id || m.id === tempId ? { ...m, id: data.id, status: data.status } : m,
            ),
          );
          return;
        }

        if (data.event !== "new_message" && data.event !== undefined) return;

        if (seenIds.current.has(data.id)) return;
        seenIds.current.add(data.id);

        const newMsg: Message = {
          id: data.id,
          role: data.role,
          content: data.content ?? null,
          status: data.status,
          created_at: data.created_at,
          reply_to_id: data.reply_to_id ?? null,
          reaction: data.reaction ?? null,
          display_compact: !!data.display_compact,
          metadata: data.metadata,
        };

        // Race fix: SSE may deliver our just-sent user message before the POST
        // response has set up the pendingIdMap mapping. In that case, find the
        // matching temp echo by content and reconcile in-place instead of
        // appending a duplicate.
        if (newMsg.role === "user" && typeof newMsg.id === "string" && !newMsg.id.startsWith("temp-")) {
          let reconciled = false;
          setMessages((prev) => {
            const matchIdx = prev.findIndex(
              (cand) =>
                cand.id.startsWith("temp-") &&
                cand.role === "user" &&
                (cand.content ?? "") === (newMsg.content ?? "") &&
                (cand.reply_to_id ?? null) === (newMsg.reply_to_id ?? null) &&
                Math.abs(new Date(cand.created_at).getTime() - new Date(newMsg.created_at).getTime()) < 30_000,
            );
            if (matchIdx < 0) return prev;
            reconciled = true;
            const tempId = prev[matchIdx].id;
            pendingIdMap.current.set(newMsg.id, tempId);
            const next = prev.slice();
            next[matchIdx] = { ...next[matchIdx], ...newMsg };
            return next;
          });
          if (reconciled) return;
        }

        setMessages((prev) => [...prev, newMsg]);

        // Mark assistant/system messages as delivered.
        if (data.role !== "user" && data.status !== "delivered" && !data.reaction) {
          fetch(`/api/chat/messages/${data.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "delivered" }),
          }).catch(() => {
            /* noop */
          });
        }
      } catch (err) {
        console.error("[chat] SSE parse error:", err);
      }
    };
    es.onerror = () => {
      /* auto-reconnects */
    };
    return () => es.close();
  }, [convId]);

  // ---- Safety sweep poll (30s) ----------------------------------------
  useEffect(() => {
    if (!convId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/chat/messages?conversation_id=${convId}&limit=200`);
        if (!res.ok) return;
        const data = await res.json();
        const serverMsgs = (data.messages ?? []) as Message[];

        setMessages((prev) => {
          const serverMap = new Map(serverMsgs.map((m) => [m.id, m]));
          let updated = prev.map((msg) => {
            const server = serverMap.get(msg.id);
            if (!server) return msg;
            const needsUpdate =
              server.status !== msg.status ||
              (server.content?.length ?? 0) > (msg.content?.length ?? 0);
            return needsUpdate
              ? { ...msg, status: server.status, content: server.content ?? msg.content }
              : msg;
          });
          const existingIds = new Set(prev.map((m) => m.id));
          const newMsgs = serverMsgs.filter(
            (m) => !existingIds.has(m.id) && !seenIds.current.has(m.id),
          );
          for (const m of newMsgs) seenIds.current.add(m.id);
          if (newMsgs.length > 0) updated = [...updated, ...newMsgs];
          return updated;
        });
      } catch (err) {
        console.error("[chat] sweep failed:", err);
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [convId]);

  // ---- Derived: parent lookup + reactions by target -------------------
  const { parentFor, reactionsFor, reactionIds } = useMemo(() => {
    const byId = new Map<string, Message>(messages.map((m) => [m.id, m]));
    const reactionsByTarget = new Map<string, Message[]>();
    const rxnIdSet = new Set<string>();
    for (const m of messages) {
      if (m.reaction && m.reply_to_id) {
        rxnIdSet.add(m.id);
        const arr = reactionsByTarget.get(m.reply_to_id) || [];
        arr.push(m);
        reactionsByTarget.set(m.reply_to_id, arr);
      }
    }
    return {
      parentFor: (id: string | null | undefined) => (id ? byId.get(id) : undefined),
      reactionsFor: (id: string) => reactionsByTarget.get(id) ?? [],
      reactionIds: rxnIdSet,
    };
  }, [messages]);

  // ---- Group messages for rendering: fold consecutive compact rows ---
  type RenderItem =
    | { kind: "bubble"; m: Message }
    | { kind: "compact"; items: Message[] };

  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = [];
    for (const m of messages) {
      if (reactionIds.has(m.id)) continue; // reactions are rendered under parent
      if (m.display_compact) {
        const last = items[items.length - 1];
        if (last && last.kind === "compact" && closeInTime(last.items[last.items.length - 1], m)) {
          last.items.push(m);
          continue;
        }
        items.push({ kind: "compact", items: [m] });
        continue;
      }
      items.push({ kind: "bubble", m });
    }
    return items;
  }, [messages, reactionIds]);

  // ---- Actions --------------------------------------------------------
  const doReact = useCallback(async (m: Message, reaction: Reaction) => {
    try {
      await fetch(`/api/chat/messages/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction }),
      });
      // SSE will push the new row — no optimistic insert.
    } catch (err) {
      console.error("[chat] react failed:", err);
    }
  }, []);

  const doRemoveReaction = useCallback(async (reactionMsg: Message) => {
    if (!reactionMsg.reply_to_id) return;
    try {
      await fetch(`/api/chat/messages/${reactionMsg.reply_to_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction: null }),
      });
      // Optimistically remove.
      setMessages((prev) => prev.filter((x) => x.id !== reactionMsg.id));
    } catch (err) {
      console.error("[chat] remove reaction failed:", err);
    }
  }, []);

  const doNewConversation = useCallback(async (summary: string) => {
    setNewDialogOpen(false);
    try {
      const res = await fetch("/api/chat/conversations/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.conversation_id) {
          setMessages([]);
          seenIds.current.clear();
          setConvId(data.conversation_id);
          setSidebarKey((k) => k + 1);
          setReplyTo(null);
        }
      }
    } catch (err) {
      console.error("[chat] new conversation failed:", err);
    }
  }, []);

  const sendMessage = async () => {
    const text = input.trim();
    if ((!text && !pendingImage) || sending) return;
    setInput("");
    setSending(true);

    let imageUrl: string | undefined;
    let imageFilename: string | undefined;
    if (pendingImage) {
      try {
        const formData = new FormData();
        formData.append("file", pendingImage.file);
        const uploadRes = await fetch("/api/chat/upload", { method: "POST", body: formData });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          imageUrl = uploadData.url;
          imageFilename = uploadData.filename;
        }
      } catch (err) {
        console.error("[chat] upload failed:", err);
      }
      URL.revokeObjectURL(pendingImage.preview);
      setPendingImage(null);
    }

    const tempId = `temp-${Date.now()}`;
    const replyId = replyTo?.id;
    const userMsg: Message = {
      id: tempId,
      role: "user",
      content: text || "",
      status: "pending",
      created_at: new Date().toISOString(),
      reply_to_id: replyId ?? null,
      ...(imageUrl
        ? { metadata: { attachments: [{ type: "image", url: imageUrl, filename: imageFilename }] } }
        : {}),
    };
    setMessages((prev) => [...prev, userMsg]);
    seenIds.current.add(tempId);
    setReplyTo(null);

    try {
      const body: Record<string, unknown> = { channel: "web", content: text || "" };
      if (convId) body.conversation_id = convId;
      if (replyId) body.reply_to_id = replyId;
      if (imageUrl) {
        body.metadata = { attachments: [{ type: "image", url: imageUrl, filename: imageFilename }] };
      }
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.id) {
          seenIds.current.add(data.id);
          pendingIdMap.current.set(data.id, tempId);
          setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, id: data.id } : m)));
        }
        if (data.conversation_id && data.conversation_id !== convId) {
          // Rerouted (e.g. via 30s grace) — pivot.
          setConvId(data.conversation_id);
        }
      } else if (res.status === 409) {
        const data = await res.json();
        if (data.code === "conversation_archived" && data.active_conversation_id) {
          setConvId(data.active_conversation_id);
        }
      }
    } catch (err) {
      console.error("[chat] send failed:", err);
    }
    setSending(false);
  };

  // ---- Typing indicator visibility -----------------------------------
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user" && !m.reaction);
  const isWaiting =
    (lastUserMsg?.status === "processing" || lastUserMsg?.status === "pending") &&
    (!lastUserMsg?.created_at || Date.now() - new Date(lastUserMsg.created_at).getTime() < 60000);

  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <div className="w-64 h-full shrink-0">
          <ChatSidebar
            activeId={convId}
            onSelect={(id) => {
              if (id !== convId) setConvId(id);
            }}
            onNewConversation={() => setNewDialogOpen(true)}
            onClose={() => setSidebarOpen(false)}
            refreshKey={sidebarKey}
          />
        </div>
      )}
      <div className="flex flex-col h-full flex-1 bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-2">
            <button
              className="p-1 text-gray-500 hover:text-gray-800 rounded"
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? "Hide conversations" : "Show conversations"}
            >
              <LayoutList className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold text-gray-700">Chat</span>
          </div>
          {initialized && (
            <button
              className="text-xs text-gray-500 hover:text-gray-800"
              onClick={() => setNewDialogOpen(true)}
            >
              New conversation
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
          {renderItems.length === 0 && (
            <p className="text-sm text-gray-400 text-center mt-8">
              Send a message to start a conversation
            </p>
          )}
          {renderItems.map((item, i) =>
            item.kind === "compact" ? (
              <CompactGroup key={`cg-${i}`} items={item.items} />
            ) : (
              <MessageBubble
                key={item.m.id}
                m={item.m}
                parent={parentFor(item.m.reply_to_id)}
                reactions={reactionsFor(item.m.id)}
                onReply={setReplyTo}
                onReact={doReact}
                onRemoveReaction={doRemoveReaction}
              />
            ),
          )}
          {isWaiting && <TypingIndicator />}
          <div ref={messagesEnd} />
        </div>

        {/* Reply-to preview in composer */}
        {replyTo && (
          <div className="px-3 pt-2 border-t border-gray-200 flex items-center gap-2 bg-gray-50">
            <div className="flex-1 min-w-0 border-l-2 border-primary/40 pl-2">
              <div className="text-[10px] uppercase tracking-wide text-gray-400">
                Replying to {replyTo.role === "user" ? "yourself" : "assistant"}
              </div>
              <div className="text-xs text-gray-600 truncate">
                {replyTo.content ? replyTo.content.slice(0, 120) : "[image]"}
              </div>
            </div>
            <button
              className="p-1 text-gray-500 hover:text-gray-900"
              onClick={() => setReplyTo(null)}
              title="Cancel reply"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Image preview */}
        {pendingImage && (
          <div className="px-3 pt-2 border-t border-gray-200 flex items-center gap-2">
            <div className="relative inline-block">
              <img src={pendingImage.preview} alt="Preview" className="h-16 rounded-lg object-cover" />
              <button
                className="absolute -top-1 -right-1 bg-gray-700 text-white rounded-full p-0.5 hover:bg-gray-900"
                onClick={() => {
                  URL.revokeObjectURL(pendingImage.preview);
                  setPendingImage(null);
                }}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* Input */}
        <div className={`p-3 ${!pendingImage && !replyTo ? "border-t border-gray-200" : ""} flex gap-2`}>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setPendingImage({ file, preview: URL.createObjectURL(file) });
              e.target.value = "";
            }}
          />
          <button
            className="p-2 text-gray-400 hover:text-gray-600 rounded-full"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <ImagePlus className="w-4 h-4" />
          </button>
          <input
            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
          />
          <button
            className="p-2 bg-primary text-white rounded-full hover:bg-primary/90 disabled:opacity-50"
            onClick={sendMessage}
            disabled={sending || (!input.trim() && !pendingImage)}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      <NewConversationDialog
        open={newDialogOpen}
        onClose={() => setNewDialogOpen(false)}
        onConfirm={doNewConversation}
      />
    </div>
  );
}
