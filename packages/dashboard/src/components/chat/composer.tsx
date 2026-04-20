"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Send, X } from "lucide-react";
import type { Message } from "@/lib/chat/types";
import { uploadsUrl } from "@/lib/chat/format";

interface Props {
  onSend: (args: { text: string; imageUrl?: string; imageFilename?: string }) => Promise<void>;
  sending: boolean;
  replyTo: Message | null;
  onCancelReply: () => void;
  onOpenPalette: () => void;
  onOpenNewConversation: () => void;
}

const PLACEHOLDERS = [
  "What's on your mind?",
  "מה קורה?",
  "Ask, dump, vent, plan.",
  "Pick it up where we left off…",
  "Type / for commands, ⌘K for palette.",
];

function deterministicPlaceholder(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PLACEHOLDERS[Math.abs(h) % PLACEHOLDERS.length];
}

export function Composer({
  onSend,
  sending,
  replyTo,
  onCancelReply,
  onOpenPalette,
  onOpenNewConversation,
}: Props) {
  const [text, setText] = useState("");
  const [pendingImage, setPendingImage] = useState<{ file: File; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Per-session deterministic placeholder (stable across keystrokes,
  // rotates across reloads keyed on the day).
  const [placeholder] = useState(() =>
    deterministicPlaceholder(new Date().toDateString()),
  );

  const isSlashMode = text.startsWith("/");

  // Auto-grow textarea (up to ~10 lines).
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    const lineHeight = 26;
    const maxH = lineHeight * 10;
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  }, [text]);

  // Paste-to-attach image.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      const image = files.find((f) => f.type.startsWith("image/"));
      if (image) {
        e.preventDefault();
        setPendingImage({ file: image, preview: URL.createObjectURL(image) });
      }
    };
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, []);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) return;

    let imageUrl: string | undefined;
    let imageFilename: string | undefined;

    if (pendingImage) {
      setUploading(true);
      try {
        const fd = new FormData();
        fd.append("file", pendingImage.file);
        const up = await fetch("/api/chat/upload", { method: "POST", body: fd });
        if (up.ok) {
          const d = (await up.json()) as { url: string; filename: string };
          imageUrl = d.url;
          imageFilename = d.filename;
        }
      } finally {
        setUploading(false);
        URL.revokeObjectURL(pendingImage.preview);
        setPendingImage(null);
      }
    }

    setText("");
    await onSend({ text: trimmed, imageUrl, imageFilename });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Intercept cmd/ctrl+k anywhere in the composer to open the palette.
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      onOpenPalette();
      return;
    }
    // Intercept cmd/ctrl+n → open new-conversation dialog.
    if ((e.metaKey || e.ctrlKey) && e.key === "n") {
      e.preventDefault();
      onOpenNewConversation();
      return;
    }

    // Client-side slash commands on enter.
    if (e.key === "Enter" && !e.shiftKey) {
      const t = text.trim();
      if (t === "/new") {
        e.preventDefault();
        setText("");
        onOpenNewConversation();
        return;
      }
      if (t.startsWith("/clear")) {
        e.preventDefault();
        setText("");
        return;
      }
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="w-full">
      {replyTo && (
        <div className="flex items-center gap-2 mb-2 rounded-md border-l-2 border-coach-500/60 bg-surface-sunken/70 pl-2 pr-2 py-1.5">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-ink-400 font-mono">
              Replying to {replyTo.role === "user" ? "yourself" : "coach"}
            </div>
            <div className="text-xs text-ink-700 truncate">
              {replyTo.content ? replyTo.content.slice(0, 140) : "[image]"}
            </div>
          </div>
          <button
            className="p-1 text-ink-500 hover:text-ink-900"
            onClick={onCancelReply}
            title="Cancel reply (esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {pendingImage && (
        <div className="mb-2 inline-flex h-14 items-center gap-2 rounded-lg bg-surface-sunken pr-2 pl-1">
          <img
            src={pendingImage.preview}
            alt="Pending"
            className="h-12 w-12 rounded object-cover"
          />
          <span className="text-xs text-ink-500 font-mono max-w-[140px] truncate">
            {pendingImage.file.name}
          </span>
          <button
            className="p-1 text-ink-500 hover:text-ink-900"
            onClick={() => {
              URL.revokeObjectURL(pendingImage.preview);
              setPendingImage(null);
            }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div
        className={
          "rounded-2xl border bg-surface-composer transition " +
          "shadow-[0_1px_0_rgba(0,0,0,0.02),0_8px_24px_-12px_rgba(31,29,26,0.12)] " +
          "focus-within:shadow-[0_12px_32px_-12px_rgba(31,29,26,0.18)] " +
          "focus-within:border-ink-500/40 border-ink-300/70"
        }
      >
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          dir="auto"
          className={
            "w-full resize-none bg-transparent outline-none px-4 pt-3.5 " +
            "text-[17px] leading-[1.6] text-ink-900 placeholder:text-ink-400 " +
            (isSlashMode ? "font-mono" : "")
          }
          style={{ minHeight: "26px" }}
        />
        <div className="flex items-center justify-between px-3 pb-2 pt-1">
          <div className="flex items-center gap-1">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setPendingImage({ file: f, preview: URL.createObjectURL(f) });
                e.target.value = "";
              }}
            />
            <button
              className="p-1.5 rounded text-ink-400 hover:text-ink-900 hover:bg-surface-sunken"
              onClick={() => fileInput.current?.click()}
              title="Attach image"
              type="button"
            >
              <ImagePlus className="w-4 h-4" />
            </button>
            <span className="text-[11px] text-ink-400 font-mono select-none px-1">
              /
            </span>
            {isSlashMode && (
              <SlashHint text={text} />
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink-400 font-mono hidden sm:inline">
              ⌘K palette · ⌘N new · ⌘↵ send
            </span>
            <button
              disabled={sending || uploading || (!text.trim() && !pendingImage)}
              onClick={() => void handleSend()}
              className={
                "inline-flex items-center gap-1.5 rounded-full h-8 pl-2.5 pr-3 text-[12px] " +
                "bg-primary text-white disabled:opacity-40 hover:bg-primary-600 transition"
              }
            >
              <Send className="w-3.5 h-3.5" />
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slash-command hint popover — client-side only, no backend calls.
// ---------------------------------------------------------------------------

const SLASH_HINTS: Array<{ cmd: string; description: string }> = [
  { cmd: "/new",     description: "archive this thread + start fresh" },
  { cmd: "/clear",   description: "clear composer" },
  { cmd: "/search ", description: "jump to the search palette" },
];

function SlashHint({ text }: { text: string }) {
  const matches = SLASH_HINTS.filter((h) => h.cmd.startsWith(text));
  if (matches.length === 0) return null;
  return (
    <div className="ml-1 hidden sm:flex items-center gap-2 text-[11px] text-ink-400 font-mono">
      {matches.slice(0, 3).map((m) => (
        <span key={m.cmd}>
          <span className="text-ink-700">{m.cmd}</span>
          <span className="text-ink-400"> — {m.description}</span>
        </span>
      ))}
    </div>
  );
}
