"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Message, Reaction } from "@/lib/chat/types";

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

type Source = "history" | "sse" | "sweep" | "echo";

interface ChatState {
  convId: string | null;
  messages: Message[];
  /** temp-id → server-id map used to reconcile optimistic echoes with SSE. */
  pendingByTempId: Record<string, string>;
  /** Monotonic version counter — incremented on every ingest. Lets the
   *  SSE subscriber know whether a pending optimistic send has been
   *  reconciled so we don't double-insert on server echo. */
  version: number;
  /** Last SSE event timestamp for the visibility-gated sweep. */
  lastSseAt: number;
  /** True while the server is working on the user's last message.
   *  Drives the "coach is thinking" indicator. */
  thinking: boolean;

  // --- actions (pure) ---
  setConv(id: string | null): void;
  ingest(source: Source, msg: Message | Message[]): void;
  promoteTemp(tempId: string, real: Partial<Message> & { id: string }): void;
  removeById(id: string): void;
  reset(): void;
  setThinking(v: boolean): void;
  noteSse(): void;
}

/** Insertion point into a sorted messages array by `created_at` asc. */
function insertSorted(arr: Message[], m: Message): Message[] {
  if (arr.length === 0 || arr[arr.length - 1].created_at <= m.created_at) {
    return [...arr, m];
  }
  // Binary insert.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].created_at <= m.created_at) lo = mid + 1;
    else hi = mid;
  }
  const copy = arr.slice();
  copy.splice(lo, 0, m);
  return copy;
}

/** Deep-enough merge for a message update. Prefer fields that look
 *  "further along": non-null content beats null; longer content beats
 *  shorter (SSE payload truncates at 4k chars); newer status wins. */
function mergeMessage(prev: Message, next: Partial<Message>): Message {
  const out: Message = { ...prev, ...next };
  if (next.content == null && prev.content != null) out.content = prev.content;
  if (next.content != null && prev.content != null && prev.content.length > next.content.length) {
    out.content = prev.content;
  }
  // Status machine: pending → processing → delivered; never regress.
  const rank: Record<string, number> = { pending: 0, processing: 1, delivered: 2, failed: 3 };
  if (prev.status && next.status && (rank[prev.status] ?? 0) > (rank[next.status] ?? 0)) {
    out.status = prev.status;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useChatStore = create<ChatState>((set, get) => ({
  convId: null,
  messages: [],
  pendingByTempId: {},
  version: 0,
  lastSseAt: 0,
  thinking: false,

  setConv(id) {
    if (id === get().convId) return;
    set({ convId: id, messages: [], pendingByTempId: {}, version: 0, thinking: false });
  },

  /**
   * One funnel for every message arrival. Handles:
   *   - promoting optimistic echoes when their server id arrives,
   *   - deduping by id,
   *   - merging status/content updates in place,
   *   - inserting new rows in created_at order.
   */
  ingest(source, input) {
    const list = Array.isArray(input) ? input : [input];
    if (list.length === 0) return;

    set((state) => {
      const msgs = state.messages.slice();
      const byId = new Map(msgs.map((m, i) => [m.id, i] as const));
      const pendingInverse = new Map<string, string>(); // serverId -> tempId
      for (const [tempId, realId] of Object.entries(state.pendingByTempId)) {
        pendingInverse.set(realId, tempId);
      }

      for (const m of list) {
        // Reconcile optimistic echoes: if this id matches a pending slot,
        // replace the temp row in-place.
        const maybeTemp = pendingInverse.get(m.id);
        if (maybeTemp && byId.has(maybeTemp)) {
          const idx = byId.get(maybeTemp)!;
          msgs[idx] = mergeMessage({ ...msgs[idx], id: m.id }, m);
          byId.delete(maybeTemp);
          byId.set(m.id, idx);
          continue;
        }

        const existingIdx = byId.get(m.id);
        if (existingIdx != null) {
          msgs[existingIdx] = mergeMessage(msgs[existingIdx], m);
          continue;
        }

        // Race fix: SSE can deliver the user's just-sent message BEFORE the
        // POST response has had a chance to call promoteTemp(). Without this,
        // the temp echo and the SSE row both stay in the array (later
        // promoteTemp creates two rows sharing the real id). Detect by
        // matching role + content + reply_to_id with a recent temp echo.
        if (m.role === "user" && typeof m.id === "string" && !m.id.startsWith("temp-")) {
          const matchIdx = msgs.findIndex(
            (cand) =>
              cand.id.startsWith("temp-") &&
              cand.role === "user" &&
              (cand.content ?? "") === (m.content ?? "") &&
              (cand.reply_to_id ?? null) === (m.reply_to_id ?? null) &&
              Math.abs(new Date(cand.created_at).getTime() - new Date(m.created_at).getTime()) < 30_000,
          );
          if (matchIdx >= 0) {
            const tempId = msgs[matchIdx].id;
            msgs[matchIdx] = mergeMessage({ ...msgs[matchIdx], id: m.id }, m);
            byId.delete(tempId);
            byId.set(m.id, matchIdx);
            continue;
          }
        }

        // Fresh message. Binary-insert by created_at.
        const inserted = insertSorted(msgs, m);
        msgs.length = 0;
        msgs.push(...inserted);
        byId.clear();
        msgs.forEach((mm, i) => byId.set(mm.id, i));
      }

      // Prune pending map for entries that have been reconciled.
      const stillPending: Record<string, string> = {};
      for (const [tempId, realId] of Object.entries(state.pendingByTempId)) {
        if (!byId.has(realId)) stillPending[tempId] = realId;
      }

      return {
        messages: msgs,
        pendingByTempId: stillPending,
        version: state.version + 1,
        ...(source === "sse" ? { lastSseAt: Date.now() } : {}),
      };
    });
  },

  promoteTemp(tempId, real) {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === tempId);
      if (idx < 0) {
        // Temp row was already replaced by an SSE event — just track the
        // mapping so future SSE events targeting `real.id` merge cleanly.
        return { pendingByTempId: { ...state.pendingByTempId, [tempId]: real.id } };
      }
      const msgs = state.messages.slice();
      msgs[idx] = mergeMessage({ ...msgs[idx], id: real.id }, real);
      return {
        messages: msgs,
        pendingByTempId: { ...state.pendingByTempId, [tempId]: real.id },
        version: state.version + 1,
      };
    });
  },

  removeById(id) {
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
      version: state.version + 1,
    }));
  },

  setThinking(v) {
    set({ thinking: v });
  },

  noteSse() {
    set({ lastSseAt: Date.now() });
  },

  reset() {
    set({ convId: null, messages: [], pendingByTempId: {}, version: 0, thinking: false });
  },
}));

// ---------------------------------------------------------------------------
// Hook: start/stop SSE subscription + visibility-gated sweep.
// ---------------------------------------------------------------------------

/**
 * Install the session side effects (SSE + safety sweep) for the chat
 * store. Call once at the top of the chat route. Returns nothing.
 *
 * SSE is the primary delivery path. The sweep runs every 15s but only
 * when the tab is visible AND no SSE event has landed in the last 10s
 * — enough to catch the edge case of a backgrounded tab whose
 * EventSource was paused by the browser and missed a reconnect.
 */
export function useChatSession(): void {
  const convId = useChatStore((s) => s.convId);

  // SSE
  useEffect(() => {
    const es = new EventSource("/api/chat/listen");

    es.onmessage = (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type === "connected" || data.type === "error") return;

      useChatStore.getState().noteSse();

      // Conversation lifecycle — pivot if the open conv was archived.
      if (data.type === "conversation_archived" || data.type === "conversation_created") {
        if (data.type === "conversation_archived" && data.conversation_id === useChatStore.getState().convId) {
          // Fetch the new active and switch.
          fetch("/api/chat/conversations/active")
            .then((r) => (r.ok ? r.json() : null))
            .then((j: { conversation_id?: string } | null) => {
              if (j?.conversation_id) useChatStore.getState().setConv(j.conversation_id);
            })
            .catch(() => { /* noop */ });
        }
        return;
      }

      if (data.event === "status_update") {
        const id = data.id as string | undefined;
        const status = data.status as string | undefined;
        if (!id || !status) return;
        // Merge status via ingest (it handles id-then-status merging).
        useChatStore.getState().ingest("sse", {
          id,
          role: "assistant",
          content: null,
          created_at: new Date().toISOString(),
          status,
        } as Message);
        return;
      }

      if (data.event !== "new_message" && data.event !== undefined) return;
      const cur = useChatStore.getState().convId;
      if (data.conversation_id && data.conversation_id !== cur) return;

      const msg: Message = {
        id: data.id as string,
        role: (data.role as Message["role"]) ?? "assistant",
        content: (data.content as string | null) ?? null,
        status: data.status as string | undefined,
        created_at: data.created_at as string,
        reply_to_id: (data.reply_to_id as string | null) ?? null,
        reaction: (data.reaction as string | null) ?? null,
        display_compact: Boolean(data.display_compact),
        metadata: data.metadata as Message["metadata"],
      };
      useChatStore.getState().ingest("sse", msg);

      // When an assistant message lands, we're no longer "thinking".
      if (msg.role !== "user" && !msg.reaction) {
        useChatStore.getState().setThinking(false);
      }

      // Mark non-user non-reaction messages delivered so the dashboard
      // tile's status indicator stops at "processing" → "delivered".
      if (msg.role !== "user" && msg.status !== "delivered" && !msg.reaction) {
        fetch(`/api/chat/messages/${msg.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "delivered" }),
        }).catch(() => { /* noop */ });
      }
    };

    return () => es.close();
    // Intentionally not convId-dependent — SSE stream is per-user, not per-conv.
  }, []);

  // Safety sweep — only when tab is visible and SSE has been quiet.
  useEffect(() => {
    if (!convId) return;
    let stopped = false;

    async function tick() {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const since = Date.now() - useChatStore.getState().lastSseAt;
      if (since < 10_000) return; // SSE recently active — trust it.

      try {
        const res = await fetch(`/api/chat/messages?conversation_id=${convId}&limit=200`);
        if (!res.ok) return;
        const data = (await res.json()) as { messages?: Message[] };
        if (data.messages) useChatStore.getState().ingest("sweep", data.messages);
      } catch { /* noop */ }
    }

    const interval = setInterval(tick, 15_000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [convId]);
}

// ---------------------------------------------------------------------------
// Selector helpers (stable shapes for components)
// ---------------------------------------------------------------------------

export function useMessages(): Message[] {
  return useChatStore(useShallow((s) => s.messages));
}

export function useConvId(): string | null {
  return useChatStore((s) => s.convId);
}

export function useThinking(): boolean {
  return useChatStore((s) => s.thinking);
}

// ---------------------------------------------------------------------------
// Higher-level actions (live outside the store so they can make network calls)
// ---------------------------------------------------------------------------

export async function sendChatMessage(args: {
  text: string;
  convId: string | null;
  replyToId?: string | null;
  imageUrl?: string;
  imageFilename?: string;
}): Promise<{ ok: true; id: string; convId: string } | { ok: false; error: string }> {
  const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  const attachments = args.imageUrl
    ? [{ type: "image", url: args.imageUrl, filename: args.imageFilename }]
    : undefined;

  const echoed: Message = {
    id: tempId,
    role: "user",
    content: args.text,
    status: "pending",
    created_at: now,
    reply_to_id: args.replyToId ?? null,
    ...(attachments ? { metadata: { attachments } } : {}),
  };
  useChatStore.getState().ingest("echo", echoed);
  useChatStore.getState().setThinking(true);

  try {
    const body: Record<string, unknown> = { channel: "web", content: args.text };
    if (args.convId) body.conversation_id = args.convId;
    if (args.replyToId) body.reply_to_id = args.replyToId;
    if (attachments) body.metadata = { attachments };

    const res = await fetch("/api/chat/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = (await res.json()) as { id: string; conversation_id: string };
      useChatStore.getState().promoteTemp(tempId, { id: data.id, status: "pending" });
      // If the server rerouted (grace window) or we had no conv id, pivot.
      if (data.conversation_id !== args.convId) {
        useChatStore.getState().setConv(data.conversation_id);
      }
      return { ok: true, id: data.id, convId: data.conversation_id };
    }

    if (res.status === 409) {
      const data = (await res.json()) as { code?: string; active_conversation_id?: string };
      if (data.code === "conversation_archived" && data.active_conversation_id) {
        // Remove the optimistic echo — retry with the new active conversation.
        useChatStore.getState().removeById(tempId);
        useChatStore.getState().setConv(data.active_conversation_id);
        return sendChatMessage({ ...args, convId: data.active_conversation_id });
      }
    }

    useChatStore.getState().removeById(tempId);
    useChatStore.getState().setThinking(false);
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    useChatStore.getState().removeById(tempId);
    useChatStore.getState().setThinking(false);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function reactToMessage(messageId: string, reaction: Reaction | null): Promise<void> {
  try {
    await fetch(`/api/chat/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reaction }),
    });
    // Optimistic removal if clearing — SSE will deliver the insert on adds.
    if (reaction === null) {
      const state = useChatStore.getState();
      const ownReaction = state.messages.find(
        (m) => m.reaction != null && m.reply_to_id === messageId && m.role === "user",
      );
      if (ownReaction) state.removeById(ownReaction.id);
    }
  } catch { /* noop — SSE will reconcile eventually */ }
}

export async function startNewConversation(summary: string | null): Promise<string | null> {
  try {
    const res = await fetch("/api/chat/conversations/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { conversation_id?: string };
    if (data.conversation_id) {
      useChatStore.getState().setConv(data.conversation_id);
      return data.conversation_id;
    }
  } catch { /* noop */ }
  return null;
}
