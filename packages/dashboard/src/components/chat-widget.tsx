"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send } from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

export function ChatWidget() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const seenIds = useRef(new Set<string>());
  const messagesEnd = useRef<HTMLDivElement>(null);
  const lastTs = useRef("");

  const scrollToBottom = () => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);

  // Load most recent conversation on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/chat/conversations?channel=web&limit=1", {
          credentials: "same-origin",
        });
        if (res.ok) {
          const data = await res.json();
          console.log("[chat] conversations:", data);
          const latest = data.conversations?.[0];
          if (latest?.conversation_id) {
            setConvId(latest.conversation_id);
          }
        } else {
          console.log("[chat] conversations failed:", res.status);
        }
      } catch (e) {
        console.log("[chat] conversations error:", e);
      }
      setInitialized(true);
    })();
  }, []);

  // Poll for new messages
  const poll = useCallback(async () => {
    if (!convId) return;
    const since = lastTs.current ? `&since=${encodeURIComponent(lastTs.current)}` : "";
    try {
      const res = await fetch(`/api/chat/messages?conversation_id=${convId}${since}`);
      if (!res.ok) return;
      const data = await res.json();
      const newMsgs: Message[] = [];
      for (const m of data.messages ?? []) {
        if (seenIds.current.has(m.id)) continue;
        seenIds.current.add(m.id);
        if (m.role !== "user" || m.direction === "outbound") {
          newMsgs.push(m);
        }
        lastTs.current = m.created_at;
        // Mark as delivered
        if (m.status === "pending" || m.status === "processing") {
          fetch(`/api/chat/messages/${m.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "delivered" }),
          }).catch(() => {});
        }
      }
      if (newMsgs.length > 0) {
        setMessages((prev) => [...prev, ...newMsgs]);
      }
    } catch { /* ignore */ }
  }, [convId]);

  useEffect(() => {
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [poll]);

  // Load history when convId is set
  useEffect(() => {
    if (!convId) return;
    (async () => {
      try {
        const res = await fetch(`/api/chat/messages?conversation_id=${convId}&limit=100`);
        if (!res.ok) return;
        const data = await res.json();
        seenIds.current.clear();
        const loaded: Message[] = [];
        for (const m of data.messages ?? []) {
          seenIds.current.add(m.id);
          loaded.push(m);
          lastTs.current = m.created_at;
        }
        setMessages(loaded);
      } catch { /* ignore */ }
    })();
  }, [convId]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    // Optimistic add
    const tempId = `temp-${Date.now()}`;
    const userMsg: Message = {
      id: tempId,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    seenIds.current.add(tempId);

    try {
      const body: Record<string, string> = { channel: "web", content: text };
      if (convId) body.conversation_id = convId;
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.id) seenIds.current.add(data.id);
        if (!convId && data.conversation_id) {
          setConvId(data.conversation_id);
        }
      }
    } catch { /* ignore */ }
    setSending(false);
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
        <span className="text-sm font-semibold text-gray-700">Chat</span>
        {convId && (
          <button
            className="text-xs text-gray-400 hover:text-gray-600"
            onClick={() => {
              setConvId(null);
              setMessages([]);
              seenIds.current.clear();
              lastTs.current = "";
            }}
          >
            New
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {messages.length === 0 && (
          <p className="text-sm text-gray-400 text-center mt-8">
            Send a message to start a conversation
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
              m.role === "user"
                ? "ml-auto bg-primary text-white rounded-br-sm"
                : "mr-auto bg-gray-100 text-gray-900 rounded-bl-sm"
            }`}
          >
            {m.content}
          </div>
        ))}
        <div ref={messagesEnd} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-gray-200 flex gap-2">
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
          disabled={sending || !input.trim()}
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
