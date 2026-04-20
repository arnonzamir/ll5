"use client";

import { useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (summary: string) => void;
}

/** Shared new-conversation dialog. The dashboard widget's version had
 *  essentially the same copy + layout — this is the single source. */
export function NewConversationDialog({ open, onClose, onConfirm }: Props) {
  const [summary, setSummary] = useState("");
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 border border-ink-300/40"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-ink-900 mb-2">
          Start a new conversation?
        </h3>
        <p className="text-xs text-ink-500 mb-3">
          The current thread is archived and a fresh one opens. Your
          assistant&apos;s memory isn&apos;t cleared — only the visible
          scrollback resets. Add a short note for yourself (optional).
        </p>
        <textarea
          rows={4}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="3–6 lines: topics, decisions, open threads…"
          className="w-full text-sm border border-ink-300/60 rounded p-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-ink-500 hover:text-ink-900"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const s = summary.trim();
              setSummary("");
              onConfirm(s);
            }}
            className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-600"
          >
            Start new
          </button>
        </div>
      </div>
    </div>
  );
}
