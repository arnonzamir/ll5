"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefreshCw, MessageSquare, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import {
  fetchSessions,
  fetchSession,
  type SessionSummary,
  type SessionDetail,
} from "./sessions-server-actions";

function formatDate(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (err) {
    console.warn("[sessions] formatDate failed:", err instanceof Error ? err.message : String(err));
    return ts;
  }
}

function formatDuration(first: string, last: string): string {
  if (!first || !last) return "";
  try {
    const ms = new Date(last).getTime() - new Date(first).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  } catch (err) {
    console.warn("[sessions] formatDuration failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [isPending, startTransition] = useTransition();
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const PAGE_SIZE = 20;

  const load = useCallback((p: number) => {
    startTransition(async () => {
      const data = await fetchSessions(PAGE_SIZE, p * PAGE_SIZE);
      setSessions(data.sessions);
      setTotal(data.total);
    });
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  function openSession(sessionId: string) {
    startTransition(async () => {
      const detail = await fetchSession(sessionId);
      if (detail) {
        setSelectedSession(detail);
        setDialogOpen(true);
      }
    });
  }

  function handlePageChange(newPage: number) {
    setPage(newPage);
    load(newPage);
  }

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8rem)" }}>
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Sessions</h1>
          <p className="text-sm text-gray-500 mt-1">
            Agent conversation history
          </p>
        </div>
        <Button
          onClick={() => load(page)}
          disabled={isPending}
          variant="outline"
          size="sm"
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${isPending ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 pb-4">
        {sessions.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
              <MessageSquare className="h-12 w-12 mb-3" />
              <p className="text-sm">No sessions indexed yet.</p>
              <p className="text-xs mt-1">Run the backup script to index sessions.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <Card
                key={s.session_id}
                className="hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => openSession(s.session_id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <MessageSquare className="h-4 w-4 text-gray-400 shrink-0" />
                      <div>
                        <div className="text-sm font-medium">
                          {formatDate(s.first_message)}
                        </div>
                        <div className="text-xs text-gray-400 flex items-center gap-2 mt-0.5">
                          <span>{s.message_count} messages</span>
                          <span className="text-gray-300">·</span>
                          <Clock className="h-3 w-3" />
                          <span>{formatDuration(s.first_message, s.last_message)}</span>
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-gray-300 font-mono">
                      {s.session_id.slice(0, 8)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-4 mt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => handlePageChange(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-gray-500">
              {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => handlePageChange(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              Session {selectedSession?.session_id.slice(0, 8)}
              <span className="text-sm font-normal text-gray-400 ml-2">
                {selectedSession?.message_count} messages
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-3 pt-2">
            {selectedSession?.messages.map((m, i) => (
              <div
                key={i}
                className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-primary text-white rounded-br-sm"
                      : "bg-gray-100 text-gray-900 rounded-bl-sm"
                  }`}
                >
                  {m.text}
                </div>
                {m.timestamp && (
                  <span className="text-[10px] text-gray-300 mt-0.5 px-1">
                    {formatDate(m.timestamp)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
