"use client";

import { useCallback, useEffect, useState } from "react";
import { LayoutList } from "lucide-react";
import type { Message, Reaction } from "@/lib/chat/types";
import {
  useChatSession,
  useChatStore,
  useConvId,
  useMessages,
  useThinking,
  sendChatMessage,
  reactToMessage,
  startNewConversation,
} from "@/hooks/use-chat-store";
import { Composer } from "./composer";
import { ConversationList } from "./conversation-list";
import { MessageStream } from "./message-stream";
import { CommandPalette } from "./command-palette";
import { NewConversationDialog } from "./new-conversation-dialog";

/**
 * Top-level client shell for /chat. Owns:
 *   - installing the chat session (cache hydration + SSE + sweep) once
 *   - keyboard shortcuts (cmd+k, cmd+n, cmd+b, cmd+enter, esc)
 *   - layout between sidebar / stream / composer
 *   - new-conversation dialog + command palette
 *
 * Initial state hydrates from localStorage cache inside useChatSession() —
 * the page renders the shell instantly and messages appear in <50ms when
 * cache hits. Server fetch happens in parallel and merges as it lands.
 */
export function ChatRoot() {
  useChatSession();

  const convId = useConvId();
  const messages = useMessages();
  const thinking = useThinking();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [sending, setSending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Keyboard shortcuts — installed globally on the route. Each condition
  // is explicit so shortcuts inside inputs don't accidentally fire.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      // cmd+k palette
      if (meta && e.key === "k") { e.preventDefault(); setPaletteOpen((v) => !v); return; }
      // cmd+n new conversation
      if (meta && e.key === "n") { e.preventDefault(); setNewDialogOpen(true); return; }
      // cmd+b toggle sidebar
      if (meta && e.key === "b") { e.preventDefault(); setSidebarOpen((v) => !v); return; }
      // esc: clear reply, else close overlays
      if (e.key === "Escape") {
        if (paletteOpen)      { setPaletteOpen(false); return; }
        if (newDialogOpen)    { setNewDialogOpen(false); return; }
        if (replyTo)          { setReplyTo(null); return; }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, newDialogOpen, replyTo]);

  // When the active conversation pivots mid-session (grace-window reroute
  // or conversation_archived → new active), pull fresh history for the new
  // conv. Bootstrap fetch in useChatSession handles the initial mount; this
  // effect only fires on subsequent convId changes.
  const [bootstrappedConvId, setBootstrappedConvId] = useState<string | null>(null);
  useEffect(() => {
    if (!convId) return;
    if (bootstrappedConvId === null) {
      // First convId hydration — useChatSession handled it.
      setBootstrappedConvId(convId);
      return;
    }
    if (convId === bootstrappedConvId) return;
    setBootstrappedConvId(convId);
    (async () => {
      try {
        const res = await fetch(`/api/chat/messages?conversation_id=${convId}&limit=30`);
        if (res.ok) {
          const data = (await res.json()) as { messages?: Message[] };
          if (data.messages) useChatStore.getState().ingest("history", data.messages);
        }
      } catch { /* noop */ }
    })();
  }, [convId, bootstrappedConvId]);

  const handleSend = useCallback(
    async (args: { text: string; imageUrl?: string; imageFilename?: string }) => {
      if (!args.text && !args.imageUrl) return;
      setSending(true);
      try {
        const replyId = replyTo?.id ?? null;
        setReplyTo(null);
        await sendChatMessage({
          text: args.text,
          convId: useChatStore.getState().convId,
          replyToId: replyId,
          imageUrl: args.imageUrl,
          imageFilename: args.imageFilename,
        });
      } finally {
        setSending(false);
      }
    },
    [replyTo],
  );

  const handleReact = useCallback((m: Message, r: Reaction) => {
    void reactToMessage(m.id, r);
  }, []);

  const handleRemoveReaction = useCallback((reactionMsg: Message) => {
    if (reactionMsg.reply_to_id) void reactToMessage(reactionMsg.reply_to_id, null);
  }, []);

  const handleNewConv = useCallback(async (summary: string) => {
    setNewDialogOpen(false);
    await startNewConversation(summary || null);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSelectConv = useCallback((id: string) => {
    useChatStore.getState().setConv(id);
  }, []);

  return (
    <div className="flex h-full bg-surface-page chat-surface">
      {sidebarOpen && (
        <div className="w-72 shrink-0 hidden md:block">
          <ConversationList
            activeId={convId}
            onSelect={handleSelectConv}
            onNewConversation={() => setNewDialogOpen(true)}
            onClose={() => setSidebarOpen(false)}
            refreshKey={refreshKey}
          />
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0">
        {/* Slim header with sidebar toggle + palette hint. Intentionally thin —
            the real chrome is the app-wide <Nav>. */}
        <div className="flex items-center justify-between h-10 px-4 border-b border-ink-300/30 bg-surface-thread/60">
          <div className="flex items-center gap-2">
            <button
              className="p-1 text-ink-500 hover:text-ink-900 rounded"
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? "Hide conversations (⌘B)" : "Show conversations (⌘B)"}
            >
              <LayoutList className="w-4 h-4" />
            </button>
            <span className="text-[11px] uppercase tracking-wide text-ink-400 font-mono">
              /chat
            </span>
          </div>
          <button
            onClick={() => setPaletteOpen(true)}
            className="text-[11px] text-ink-400 hover:text-ink-700 font-mono"
          >
            ⌘K palette
          </button>
        </div>

        <MessageStream
          messages={messages}
          thinking={thinking}
          onReply={setReplyTo}
          onReact={handleReact}
          onRemoveReaction={handleRemoveReaction}
        />

        <div className="sticky bottom-0 border-t border-ink-300/30 bg-surface-thread/95 backdrop-blur-sm">
          <div className="mx-auto max-w-[720px] px-4 sm:px-8 py-3">
            <Composer
              onSend={handleSend}
              sending={sending}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              onOpenPalette={() => setPaletteOpen(true)}
              onOpenNewConversation={() => setNewDialogOpen(true)}
            />
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        activeId={convId}
        onSelectConversation={handleSelectConv}
        onNewConversation={() => { setPaletteOpen(false); setNewDialogOpen(true); }}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />

      <NewConversationDialog
        open={newDialogOpen}
        onClose={() => setNewDialogOpen(false)}
        onConfirm={handleNewConv}
      />
    </div>
  );
}
