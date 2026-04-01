"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Check, CheckCheck, Loader2, AlertCircle } from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: string;
  created_at: string;
  metadata?: {
    attachments?: { type: string; url: string; filename?: string }[];
    [key: string]: unknown;
  };
}

function MessageStatus({ status }: { status?: string }) {
  switch (status) {
    case "pending":
      return <Check className="w-3 h-3 text-gray-400" />;
    case "processing":
      return <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />;
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

export function ChatWidget() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const seenIds = useRef(new Set<string>());
  const messagesEnd = useRef<HTMLDivElement>(null);

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
          const latest = data.conversations?.[0];
          if (latest?.conversation_id) {
            setConvId(latest.conversation_id);
          }
        }
      } catch { /* ignore */ }
      setInitialized(true);
    })();
  }, []);

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
        }
        setMessages(loaded);
      } catch { /* ignore */ }
    })();
  }, [convId]);

  // SSE: real-time updates via dashboard proxy
  useEffect(() => {
    if (!convId) return;

    const es = new EventSource("/api/chat/listen");

    es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "connected" || data.type === "error") return;
          if (data.conversation_id && data.conversation_id !== convId) return;

          if (data.event === "status_update") {
            // Update status of existing message
            setMessages((prev) =>
              prev.map((m) =>
                m.id === data.id ? { ...m, status: data.status } : m
              )
            );
          } else if (data.event === "new_message") {
            // New message (inbound or outbound)
            if (seenIds.current.has(data.id)) return;
            seenIds.current.add(data.id);
            // Only show assistant/system messages from SSE (user messages are added optimistically)
            if (data.role !== "user" || data.direction === "outbound") {
              const newMsg: Message = {
                id: data.id,
                role: data.role,
                content: data.content,
                status: data.status,
                created_at: data.created_at,
                metadata: data.metadata,
              };
              setMessages((prev) => [...prev, newMsg]);
            }
            // Mark assistant messages as delivered
            if (data.role !== "user" && data.status !== "delivered") {
              fetch(`/api/chat/messages/${data.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "delivered" }),
              }).catch(() => {});
            }
          } else {
            // Legacy format (from channel MCP SSE listener)
            if (data.id && !seenIds.current.has(data.id)) {
              seenIds.current.add(data.id);
            }
          }
        } catch { /* skip malformed */ }
      };

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
    };
  }, [convId]);

  // Safety sweep: slow poll every 30s to catch anything SSE missed
  useEffect(() => {
    if (!convId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/chat/messages?conversation_id=${convId}&limit=100`);
        if (!res.ok) return;
        const data = await res.json();
        const serverMsgs = (data.messages ?? []) as Message[];

        setMessages((prev) => {
          const statusMap = new Map(serverMsgs.map((m) => [m.id, m.status]));
          let updated = prev.map((msg) => {
            const serverStatus = statusMap.get(msg.id);
            return serverStatus && serverStatus !== msg.status
              ? { ...msg, status: serverStatus }
              : msg;
          });

          const existingIds = new Set(prev.map((m) => m.id));
          const newMsgs = serverMsgs.filter(
            (m) => !existingIds.has(m.id) && !seenIds.current.has(m.id)
          );
          for (const m of newMsgs) seenIds.current.add(m.id);

          if (newMsgs.length > 0) {
            updated = [...updated, ...newMsgs];
          }
          return updated;
        });
      } catch { /* ignore */ }
    }, 30000);
    return () => clearInterval(interval);
  }, [convId]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    // Optimistic add with pending status
    const tempId = `temp-${Date.now()}`;
    const userMsg: Message = {
      id: tempId,
      role: "user",
      content: text,
      status: "pending",
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
        if (data.id) {
          seenIds.current.add(data.id);
          // Map temp id to real id so SSE status updates work
          setMessages((prev) =>
            prev.map((m) => (m.id === tempId ? { ...m, id: data.id } : m))
          );
        }
        if (!convId && data.conversation_id) {
          setConvId(data.conversation_id);
        }
      }
    } catch { /* ignore */ }
    setSending(false);
  };

  // Check if agent is processing
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const isProcessing = lastUserMsg?.status === "processing";

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
            }}
          >
            New
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
        {messages.length === 0 && (
          <p className="text-sm text-gray-400 text-center mt-8">
            Send a message to start a conversation
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-primary text-white rounded-br-sm"
                  : "bg-gray-100 text-gray-900 rounded-bl-sm"
              }`}
            >
              {m.content}
            </div>
            {m.role === "user" && (
              <div className="mt-0.5 mr-1">
                <MessageStatus status={m.status} />
              </div>
            )}
          </div>
        ))}
        {isProcessing && <TypingIndicator />}
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
