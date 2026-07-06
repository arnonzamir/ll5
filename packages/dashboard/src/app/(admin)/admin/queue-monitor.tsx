"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertTriangle, Inbox, Layers } from "lucide-react";
import { pollRabbitMq, type RabbitMqStats } from "./rabbitmq-actions";

/** Friendly labels + roles for the WhatsApp ingest queues. */
const QUEUE_META: Record<string, { label: string; role: string }> = {
  "whatsapp.ingest": { label: "Ingest", role: "live — worker consumes here" },
  "whatsapp.retry": { label: "Retry", role: "TTL backoff → re-delivered" },
  "whatsapp.dlq": { label: "Dead-letter", role: "parked after max retries" },
};

function rate(n: number): string {
  return n > 0 ? `${n.toFixed(1)}/s` : "0";
}

export function QueueMonitor() {
  const [stats, setStats] = useState<RabbitMqStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await pollRabbitMq();
    setStats(result);
    setLastChecked(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  const dlqDepth = stats?.queues.find((q) => q.name === "whatsapp.dlq")?.messages ?? 0;
  const ingest = stats?.queues.find((q) => q.name === "whatsapp.ingest");
  const noConsumer = stats?.reachable && ingest !== undefined && ingest.consumers === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5" />
          <h2 className="text-xl font-semibold">WhatsApp Ingest Queue</h2>
          {stats && (
            <Badge variant={stats.reachable ? "default" : "destructive"}>
              {stats.reachable ? "broker up" : "broker down"}
            </Badge>
          )}
          {dlqDepth > 0 && <Badge variant="destructive">{dlqDepth} in DLQ</Badge>}
          {noConsumer && <Badge variant="destructive">no consumer</Badge>}
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {lastChecked && <span>updated {lastChecked.toLocaleTimeString()}</span>}
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {stats && !stats.reachable && (
        <Card>
          <CardContent className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Broker unreachable{stats.error ? ` — ${stats.error}` : ""}. WhatsApp still ingests inline (no loss).
          </CardContent>
        </Card>
      )}

      {stats?.reachable && (
        <div className="grid gap-3 sm:grid-cols-3">
          {stats.queues.map((q) => {
            const meta = QUEUE_META[q.name] ?? { label: q.name, role: "" };
            const warn = q.name === "whatsapp.dlq" && q.messages > 0;
            const backlog = q.name === "whatsapp.ingest" && q.ready > 50;
            return (
              <Card key={q.name} className={warn ? "border-destructive" : ""}>
                <CardContent className="space-y-1 py-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{meta.label}</span>
                    <Badge variant={warn || backlog ? "destructive" : "secondary"}>{q.messages} msgs</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{meta.role}</div>
                  <div className="grid grid-cols-2 gap-x-3 pt-1 text-xs">
                    <span>ready: {q.ready}</span>
                    <span>unacked: {q.unacked}</span>
                    <span>consumers: {q.consumers}</span>
                    <span>in: {rate(q.publishRate)}</span>
                    <span>ack: {rate(q.ackRate)}</span>
                    <span>state: {q.state}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {stats?.dlqSample && stats.dlqSample.length > 0 && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Inbox className="h-4 w-4" /> Dead-lettered messages (peek)
            </div>
            <div className="space-y-2">
              {stats.dlqSample.map((m, i) => (
                <div key={i} className="rounded border p-2 text-xs">
                  <div className="flex justify-between">
                    <span className="font-mono">{m.event ?? "unknown event"}</span>
                    <span className="text-muted-foreground">
                      {m.attempts !== null ? `${m.attempts} attempts` : ""}
                      {m.receivedAt ? ` · ${new Date(m.receivedAt).toLocaleString()}` : ""}
                    </span>
                  </div>
                  {m.error && <div className="mt-1 text-destructive">{m.error}</div>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
