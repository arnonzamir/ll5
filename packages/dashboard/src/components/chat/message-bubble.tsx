"use client";

import { useState } from "react";
import {
  Copy,
  MessageSquareReply,
  SmilePlus,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  REACTION_ICONS,
  REACTION_LABELS,
  REACTION_ORDER,
  compactIcon as pickCompactIcon,
  ChevronDown,
  ChevronRight,
} from "@/lib/chat/constants";
import type { Message, Reaction } from "@/lib/chat/types";
import { uploadsUrl } from "@/lib/chat/format";

// ---------------------------------------------------------------------------
// Reaction picker (hover popover)
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
      <div className="absolute z-30 bottom-full mb-1 bg-white rounded-lg shadow-lg border border-ink-300/60 px-1.5 py-1 flex gap-0.5">
        {REACTION_ORDER.map((r) => {
          const Icon = REACTION_ICONS[r];
          return (
            <button
              key={r}
              title={REACTION_LABELS[r]}
              onClick={() => onPick(r)}
              className="p-1.5 text-ink-500 hover:text-ink-900 hover:bg-surface-sunken rounded"
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
// Reaction strip under a parent bubble
// ---------------------------------------------------------------------------

export function ReactionStrip({
  reactions,
  onToggle,
}: {
  reactions: Message[];
  onToggle: (reactionMsg: Message) => void;
}) {
  if (reactions.length === 0) return null;
  const counts = reactions.reduce<Record<string, { count: number; byMe?: Message }>>(
    (acc, r) => {
      const key = r.reaction!;
      acc[key] ||= { count: 0 };
      acc[key].count++;
      if (r.role === "user") acc[key].byMe = r;
      return acc;
    },
    {},
  );

  return (
    <div className="flex gap-1 mt-1 flex-wrap">
      {Object.entries(counts).map(([rxn, { count, byMe }]) => {
        const Icon = REACTION_ICONS[rxn as Reaction];
        if (!Icon) return null;
        return (
          <button
            key={rxn}
            onClick={() => byMe && onToggle(byMe)}
            className={
              "inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[11px] border bg-transparent " +
              (byMe
                ? "border-primary/40 text-primary bg-primary/5 hover:bg-primary/10"
                : "border-ink-300/60 text-ink-500")
            }
            title={`${REACTION_LABELS[rxn as Reaction]}${byMe ? " (click to remove)" : ""}`}
          >
            <Icon className="w-3 h-3" />
            {count > 1 && <span className="font-mono">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reply quote (quoted parent above a reply)
// ---------------------------------------------------------------------------

export function ReplyQuote({ parent }: { parent: Message }) {
  const img = parent.metadata?.attachments?.find((a) => a.type === "image");
  return (
    <div className="mb-1 rounded border-l-2 border-coach-500/40 bg-surface-sunken/60 pl-2 pr-2 py-1 flex gap-2 items-start max-w-full">
      {img && (
        <img
          src={uploadsUrl(img.url)}
          alt=""
          className="w-8 h-8 object-cover rounded shrink-0"
          loading="lazy"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-ink-400 font-mono">
          {parent.role === "user" ? "You" : "Coach"}
        </div>
        <div className="text-xs text-ink-700 truncate">
          {parent.content
            ? parent.content.split("\n").slice(0, 2).join(" ").slice(0, 120)
            : img
              ? "[image]"
              : ""}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact system row + 60s grouping band
// ---------------------------------------------------------------------------

function CompactRow({ m }: { m: Message }) {
  const isThinking = m.metadata?.kind === "thinking";
  const time = new Date(m.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isThinking) {
    // Thinking lines render asterisk-prefix-italic, like Claude Code's
    // narration. No icon, no time chip — just the line, dimmer than system
    // rows so it visually recedes.
    return (
      <div
        className="flex items-start gap-2 py-0.5 px-1 text-[13px] text-ink-400 italic"
        dir="auto"
      >
        <span className="text-ink-300 shrink-0 select-none">*</span>
        <span className="flex-1 leading-snug whitespace-pre-wrap break-words">
          {m.content ?? ""}
        </span>
      </div>
    );
  }

  const Icon: LucideIcon = pickCompactIcon(m);
  return (
    <div
      className="flex items-start gap-2 py-0.5 px-1 text-[13px] text-ink-400 font-mono"
      dir="auto"
    >
      <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5 text-ink-300" />
      <span className="text-[11px] text-ink-400 shrink-0">{time}</span>
      <span className="flex-1 truncate leading-snug">{m.content ?? ""}</span>
    </div>
  );
}

export function CompactGroup({ items }: { items: Message[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 1) return <CompactRow m={items[0]} />;
  const time = new Date(items[0].created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="text-[13px] font-mono">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-ink-400 hover:text-ink-500 py-0.5 w-full"
      >
        <span className="flex-1 border-t border-ink-300/40" />
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        <span>{items.length} system events · {time}</span>
        <span className="flex-1 border-t border-ink-300/40" />
      </button>
      {expanded && (
        <div className="ml-3 pl-2 border-l border-ink-300/30">
          {items.map((m) => (
            <CompactRow key={m.id} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main bubble — used for both full-screen chat and the dashboard widget.
// ---------------------------------------------------------------------------

interface BubbleProps {
  message: Message;
  parent?: Message;
  reactions: Message[];
  /** Variant="unboxed" renders assistant/system messages as flowing prose
   *  with a coach-colored dot in the gutter (full-screen /chat look).
   *  Variant="bubble" renders the legacy gray bubble (dashboard widget). */
  variant?: "unboxed" | "bubble";
  onReply?: (m: Message) => void;
  onReact?: (m: Message, r: Reaction) => void;
  onRemoveReaction?: (reactionMsg: Message) => void;
  isLastUser?: boolean;
}

export function MessageBubble({
  message: m,
  parent,
  reactions,
  variant = "bubble",
  onReply,
  onReact,
  onRemoveReaction,
  isLastUser,
}: BubbleProps) {
  const [showPicker, setShowPicker] = useState(false);
  const isUser = m.role === "user";
  const images = m.metadata?.attachments?.filter((a) => a.type === "image") ?? [];
  const isSummary = m.metadata?.kind === "conversation_summary";

  // ----- unboxed (coach) assistant rendering ---------------------------
  if (variant === "unboxed" && !isUser) {
    return (
      <div className="group relative py-3" dir="auto">
        <div className="flex gap-3">
          {/* Coach gutter — stays visually left regardless of RTL of content.
              Uses ltr direction locally to keep the dot on the left. */}
          <div dir="ltr" className="w-5 shrink-0 pt-[11px] flex justify-start">
            <Sparkles className="w-3.5 h-3.5 text-coach-500" />
          </div>
          <div className="min-w-0 flex-1">
            {parent && <ReplyQuote parent={parent} />}
            {images.map((att, i) => (
              <img
                key={i}
                src={uploadsUrl(att.url)}
                alt={att.filename || "Image"}
                className="max-w-full rounded-lg mb-2 cursor-pointer"
                style={{ maxHeight: "360px" }}
                onClick={() => window.open(uploadsUrl(att.url), "_blank")}
                loading="lazy"
              />
            ))}
            {isSummary && (
              <div className="text-[10px] uppercase tracking-wide text-coach-700 mb-1 font-mono">
                Conversation summary
              </div>
            )}
            <div
              className="text-[17px] leading-7 text-ink-900 whitespace-pre-wrap break-words"
              dir="auto"
            >
              {m.content}
            </div>
            <ReactionStrip reactions={reactions} onToggle={onRemoveReaction ?? (() => {})} />
            <HoverBar
              align="left"
              onReply={onReply ? () => onReply(m) : undefined}
              onReactToggle={() => setShowPicker((v) => !v)}
              onCopy={() => navigator.clipboard.writeText(m.content ?? "")}
              picker={
                showPicker && onReact ? (
                  <ReactionPicker
                    onPick={(r) => {
                      setShowPicker(false);
                      onReact(m, r);
                    }}
                    onClose={() => setShowPicker(false)}
                  />
                ) : null
              }
            />
          </div>
        </div>
      </div>
    );
  }

  // ----- bubble (user, or legacy widget) -------------------------------
  return (
    <div
      className={`group flex flex-col ${isUser ? "items-end" : "items-start"} py-1`}
      dir="auto"
    >
      <div className="relative max-w-[85%]">
        <HoverBar
          align={isUser ? "right" : "left"}
          onReply={onReply ? () => onReply(m) : undefined}
          onReactToggle={() => setShowPicker((v) => !v)}
          onCopy={() => navigator.clipboard.writeText(m.content ?? "")}
          picker={
            showPicker && onReact ? (
              <ReactionPicker
                onPick={(r) => {
                  setShowPicker(false);
                  onReact(m, r);
                }}
                onClose={() => setShowPicker(false)}
              />
            ) : null
          }
        />
        <div
          className={
            "px-4 py-2.5 text-[16px] leading-[1.55] whitespace-pre-wrap break-words rounded-2xl " +
            (isUser
              ? "bg-surface-sunken text-ink-700 rounded-br-md"
              : isSummary
                ? "bg-coach-50 text-ink-900 border border-coach-500/30 rounded-bl-md"
                : "bg-gray-100 text-gray-900 rounded-bl-sm")
          }
        >
          {isSummary && !isUser && (
            <div className="text-[10px] uppercase tracking-wide text-coach-700 mb-1 font-mono">
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
        <ReactionStrip reactions={reactions} onToggle={onRemoveReaction ?? (() => {})} />
      </div>
      {isUser && m.status && (isLastUser || m.status === "failed") && (
        <div className="mt-0.5 mr-1">
          <MessageStatus status={m.status} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hover action bar (Reply / React / Copy)
// ---------------------------------------------------------------------------

function HoverBar({
  align,
  onReply,
  onReactToggle,
  onCopy,
  picker,
}: {
  align: "left" | "right";
  onReply?: () => void;
  onReactToggle?: () => void;
  onCopy?: () => void;
  picker?: React.ReactNode;
}) {
  return (
    <div
      className={
        "absolute top-0 " +
        (align === "right" ? "-left-[92px]" : "-right-[92px]") +
        " flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
      }
    >
      {onReply && (
        <button
          onClick={onReply}
          className="p-1 text-ink-400 hover:text-ink-900 hover:bg-surface-sunken rounded"
          title="Reply (r)"
        >
          <MessageSquareReply className="w-3.5 h-3.5" />
        </button>
      )}
      {onReactToggle && (
        <div className="relative">
          <button
            onClick={onReactToggle}
            className="p-1 text-ink-400 hover:text-ink-900 hover:bg-surface-sunken rounded"
            title="React (e)"
          >
            <SmilePlus className="w-3.5 h-3.5" />
          </button>
          {picker}
        </div>
      )}
      {onCopy && (
        <button
          onClick={onCopy}
          className="p-1 text-ink-400 hover:text-ink-900 hover:bg-surface-sunken rounded"
          title="Copy (c)"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message status ticks (hover-only outside of last user message)
// ---------------------------------------------------------------------------

function MessageStatus({ status }: { status?: string }) {
  if (status === "failed") {
    return <span className="text-red-500 text-[11px] font-mono">failed</span>;
  }
  if (status === "delivered") {
    return <span className="text-ink-400 text-[11px] font-mono">delivered</span>;
  }
  if (status === "processing") {
    return <span className="text-ink-400 text-[11px] font-mono">processing…</span>;
  }
  if (status === "pending") {
    return <span className="text-ink-400 text-[11px] font-mono">sending…</span>;
  }
  return null;
}
