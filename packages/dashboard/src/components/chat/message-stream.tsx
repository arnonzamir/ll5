"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Message, Reaction } from "@/lib/chat/types";
import { buildRenderItems, indexReactions } from "@/lib/chat/format";
import { CompactGroup, MessageBubble } from "./message-bubble";

interface Props {
  messages: Message[];
  thinking: boolean;
  onReply: (m: Message) => void;
  onReact: (m: Message, r: Reaction) => void;
  onRemoveReaction: (reactionMsg: Message) => void;
}

/**
 * Full-screen chat message stream. Assistant/system messages render
 * unboxed (coach-dot in gutter); user messages as quiet sunken bubbles.
 * Compact-system rows fold into 60s collapsible bands. Reactions are
 * hoisted under their parent.
 */
export function MessageStream({
  messages,
  thinking,
  onReply,
  onReact,
  onRemoveReaction,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastLenRef = useRef(0);
  const pinnedRef = useRef(true); // are we tracking the bottom?

  // Index reactions + derive the rendered item list.
  const { byTarget: reactionsByTarget, reactionIds } = useMemo(
    () => indexReactions(messages),
    [messages],
  );
  const items = useMemo(
    () => buildRenderItems(messages, reactionIds),
    [messages, reactionIds],
  );

  const byId = useMemo(
    () => new Map<string, Message>(messages.map((m) => [m.id, m])),
    [messages],
  );

  const lastUserMsg = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && !m.reaction),
    [messages],
  );

  // Track whether user is near the bottom; only auto-scroll if they are.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      pinnedRef.current = distance < 80;
    }
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (messages.length === lastLenRef.current) return;
    lastLenRef.current = messages.length;
    if (pinnedRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  return (
    <div
      ref={scroller}
      className="flex-1 overflow-y-auto bg-surface-thread chat-surface"
      style={{ scrollPaddingBottom: "96px" }}
    >
      <div className="mx-auto max-w-[720px] px-4 sm:px-8 pt-6 pb-40">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          items.map((item, i) => {
            if (item.kind === "compact") {
              return <CompactGroup key={`cg-${i}`} items={item.items} />;
            }
            return (
              <MessageBubble
                key={item.message.id}
                message={item.message}
                parent={item.message.reply_to_id ? byId.get(item.message.reply_to_id) : undefined}
                reactions={reactionsByTarget.get(item.message.id) ?? []}
                variant="unboxed"
                onReply={onReply}
                onReact={onReact}
                onRemoveReaction={onRemoveReaction}
                isLastUser={item.message.id === lastUserMsg?.id}
              />
            );
          })
        )}
        {thinking && <ThinkingCaret />}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thinking indicator — terminal caret, not the three dots.
// ---------------------------------------------------------------------------

function ThinkingCaret() {
  return (
    <div className="flex items-center gap-2 py-3 pl-8 text-ink-500 font-mono text-[14px]" dir="ltr">
      <span className="italic">coach is thinking</span>
      <span className="inline-block w-[7px] h-[14px] bg-coach-500 chat-caret" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — "ready when you are"
// ---------------------------------------------------------------------------

function EmptyState() {
  const hour = new Date().getHours();
  const greeting =
    hour < 5
      ? "Late night."
      : hour < 12
        ? "Good morning."
        : hour < 17
          ? "Good afternoon."
          : "Good evening.";

  return (
    <div className="flex flex-col items-center justify-center text-center pt-24 pb-10 px-4">
      <p className="text-ink-400 font-mono text-[13px] mb-1">~ ready when you are.</p>
      <h2 className="text-[20px] text-ink-900 font-medium mb-6">{greeting}</h2>
      <div className="w-12 border-t border-ink-300/60 mb-6" />
      <div className="flex flex-col gap-2 items-stretch w-full max-w-[420px]">
        {[
          { cmd: "/new", desc: "start a fresh thread" },
          { cmd: "What's on today?", desc: "pull up the daily briefing" },
          { cmd: "Plan tomorrow", desc: "light prep for the next day" },
        ].map((s) => (
          <div
            key={s.cmd}
            className="flex items-baseline gap-3 px-3 py-1.5 text-left rounded text-ink-500"
          >
            <span className="font-mono text-[13px] text-ink-700">{s.cmd}</span>
            <span className="text-[13px] text-ink-400">— {s.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
