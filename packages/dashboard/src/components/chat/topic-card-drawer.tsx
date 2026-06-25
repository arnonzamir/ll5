"use client";

import { useEffect, useState } from "react";
import { X, LogIn, Loader2 } from "lucide-react";
import {
  fetchNarrativeDetail,
  fetchNarrativeConnections,
  requestNarrativeSummary,
  type Narrative,
  type Observation,
  type NarrativeConnections,
  type SubjectRef,
} from "@/app/(user)/narratives/narratives-server-actions";
import { NarrativeDetailView } from "@/app/(user)/narratives/detail/narrative-detail-view";

interface Props {
  /** The narrative selected in the rail (we already have its summary fields). */
  topic: Narrative;
  onClose: () => void;
  /** Fired after a successful "Jump in" so the shell can focus the chat. */
  onJumpedIn: () => void;
}

/**
 * Slide-over "context card" for an active topic. Reuses the narratives detail
 * view (pane variant) and adds a "Jump in" action: it asks the agent for a
 * point-in-time read of the topic, which lands in the live chat thread — so you
 * continue the conversation with the narrative's context already in hand.
 */
export function TopicCardDrawer({ topic, onClose, onJumpedIn }: Props) {
  const subject: SubjectRef = topic.subject;
  const refStr = `${subject.kind}:${subject.ref}`;

  const [detail, setDetail] = useState<{ narrative: Narrative | null; observations: Observation[] } | null>(null);
  const [connections, setConnections] = useState<NarrativeConnections | null>(null);
  const [jumping, setJumping] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setConnections(null);
    (async () => {
      const [d, c] = await Promise.all([
        fetchNarrativeDetail(subject).catch(() => ({ narrative: topic, observations: [] as Observation[] })),
        fetchNarrativeConnections(subject).catch(() => null),
      ]);
      if (cancelled) return;
      // Fall back to the list item's fields if the detail fetch returned nothing.
      setDetail({ narrative: d.narrative ?? topic, observations: d.observations });
      setConnections(c);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refStr]);

  async function handleJumpIn() {
    setJumping(true);
    try {
      await requestNarrativeSummary(subject);
      onJumpedIn();
    } finally {
      setJumping(false);
    }
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-[460px] h-full bg-surface-page shadow-xl border-l border-ink-300/50 flex flex-col animate-in slide-in-from-right">
        <div className="flex items-center justify-between gap-2 px-4 h-12 border-b border-ink-300/40 shrink-0">
          <span className="text-sm font-medium text-ink-900 truncate" dir="auto">
            {topic.title || "(untitled)"}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleJumpIn}
              disabled={jumping}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-60"
              title="Bring this topic into your chat with its context"
            >
              {jumping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
              Jump in
            </button>
            <button onClick={onClose} className="p-1 text-ink-500 hover:text-ink-900 rounded" title="Close (Esc)">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {detail === null ? (
            <div className="flex items-center gap-2 text-sm text-ink-400 mt-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading context…
            </div>
          ) : (
            <NarrativeDetailView
              subject={subject}
              initial={detail}
              connections={connections}
              variant="pane"
            />
          )}
        </div>
      </div>
    </div>
  );
}
