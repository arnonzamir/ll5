"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, AlertTriangle, MessageSquare, Smartphone, Database, Server, Radio, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pollHealth, type HealthSnapshot } from "./health-actions";

const DISPLAY_NAMES: Record<string, string> = {
  gateway: "Gateway",
  knowledge: "Personal Knowledge",
  gtd: "GTD",
  awareness: "Awareness",
  google: "Google (Calendar/Gmail)",
  "ll5-calendar": "Google (Calendar/Gmail)",
  health: "Health",
  messaging: "Messaging",
  "ll5-messaging": "Messaging",
};

function fmtAgeSeconds(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function fmtAgeHours(h: number | null): string {
  if (h === null || h === undefined) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtSince(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ago = (Date.now() - new Date(iso).getTime()) / 1000;
  return `${fmtAgeSeconds(Math.max(0, Math.round(ago)))} ago`;
}

export function HealthDashboard() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await pollHealth();
    setSnapshot(result);
    setLastChecked(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  const services = snapshot?.services ?? [];
  const channels = snapshot?.channels ?? [];
  const whatsapp = snapshot?.whatsapp ?? [];
  const phones = snapshot?.phones ?? [];
  const agentOutput = snapshot?.agent_output ?? [];
  const summary = snapshot?.summary;
  const pgHealthy = snapshot?.databases.postgres.healthy ?? false;
  const pgError = snapshot?.databases.postgres.error ?? null;

  const totalIssues =
    (summary?.services_unhealthy ?? 0) +
    (summary?.channels_stale ?? 0) +
    (summary?.whatsapp_stale ?? 0) +
    (summary?.phones_stale ?? 0) +
    (summary?.agent_output_stale ?? 0) +
    (pgHealthy ? 0 : 1);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm text-gray-500">
            {lastChecked
              ? `Last checked: ${lastChecked.toLocaleTimeString()}`
              : "Checking..."}
          </p>
          {totalIssues > 0 ? (
            <div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4" />
              {(summary?.services_unhealthy ?? 0) > 0 && <span>{summary?.services_unhealthy} service(s) down</span>}
              {(summary?.channels_stale ?? 0) > 0 && <span>{summary?.channels_stale} channel(s) stalled</span>}
              {(summary?.whatsapp_stale ?? 0) > 0 && <span>{summary?.whatsapp_stale} WhatsApp stalled</span>}
              {(summary?.phones_stale ?? 0) > 0 && <span>{summary?.phones_stale} phone(s) silent</span>}
              {(summary?.agent_output_stale ?? 0) > 0 && <span>{summary?.agent_output_stale} agent silent</span>}
              {!pgHealthy && <span>Postgres down</span>}
            </div>
          ) : summary ? (
            <p className="text-sm text-green-600 mt-1">All systems nominal</p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Services */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <Server className="h-4 w-4" /> Services
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {services.map((svc) => {
            const consecutive = svc.consecutiveFailures ?? 0;
            return (
              <Card key={svc.name}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {DISPLAY_NAMES[svc.name] ?? svc.name}
                    </span>
                    <Badge variant={svc.healthy ? "success" : "destructive"}>
                      {svc.healthy ? "Healthy" : consecutive > 0 ? `Down ${consecutive}×` : "Down"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-3 w-3 rounded-full ${svc.healthy ? "bg-green-500" : "bg-red-500"}`}
                    />
                    <span className="text-xs text-gray-500">
                      {svc.responseTime}ms
                      {svc.statusCode ? ` · HTTP ${svc.statusCode}` : ""}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {svc.healthy
                      ? `Checked ${fmtSince(svc.lastCheckedAt)}`
                      : svc.error
                      ? `Error: ${svc.error}`
                      : "Error: unknown"}
                  </div>
                  {!svc.healthy && svc.lastHealthyAt && (
                    <div className="text-xs text-gray-400">
                      Last healthy: {fmtSince(svc.lastHealthyAt)}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
          {services.length === 0 && (
            <div className="text-sm text-gray-500 col-span-4">No service data yet.</div>
          )}
        </div>
      </section>

      {/* Databases */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <Database className="h-4 w-4" /> Databases
        </h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-4 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">PostgreSQL</span>
                <Badge variant={pgHealthy ? "success" : "destructive"}>
                  {pgHealthy ? "Healthy" : "Down"}
                </Badge>
              </div>
              {pgError && (
                <div className="text-xs text-red-600">{pgError}</div>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Channel bridge liveness */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <Radio className="h-4 w-4" /> Channel bridge liveness
        </h2>
        {channels.length === 0 ? (
          <p className="text-sm text-gray-500">
            No liveness snapshots yet — the monitor runs every 2 min.
          </p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {channels.map((c) => (
              <Card key={c.userId}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">User {c.userId.slice(0, 8)}…</span>
                    <Badge variant={c.stale ? "destructive" : "success"}>
                      {c.stale ? "Stalled" : "Delivering"}
                    </Badge>
                  </div>
                  <div className="text-xs text-gray-500 space-y-0.5">
                    <div>Pending inbound: <span className="font-mono">{c.pending_inbound}</span></div>
                    <div>
                      Oldest pending: <span className="font-mono">{fmtAgeSeconds(c.oldest_pending_age_seconds)}</span>
                    </div>
                    <div>Last assistant reply: {fmtSince(c.last_outbound_at)}</div>
                    <div>Last delivered inbound: {fmtSince(c.last_delivered_at)}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* WhatsApp flow */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <MessageSquare className="h-4 w-4" /> WhatsApp flow
        </h2>
        {whatsapp.length === 0 ? (
          <p className="text-sm text-gray-500">No probes yet — runs every 15 min during active hours.</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {whatsapp.map((w) => (
              <Card key={w.userId}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">User {w.userId.slice(0, 8)}…</span>
                    <Badge variant={w.stale ? "destructive" : w.account_count === 0 ? "secondary" : "success"}>
                      {w.account_count === 0 ? "No account" : w.stale ? "Stale" : "Flowing"}
                    </Badge>
                  </div>
                  <div className="text-xs text-gray-500 space-y-0.5">
                    <div>Configured accounts: <span className="font-mono">{w.account_count}</span></div>
                    <div>
                      Last inbound:{" "}
                      {w.last_message_at ? (
                        <span>
                          {fmtSince(w.last_message_at)} (
                          <span className="font-mono">{fmtAgeHours(w.last_message_age_hours)}</span>)
                        </span>
                      ) : (
                        "never"
                      )}
                    </div>
                    <div>Probe: {fmtSince(w.checked_at)}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Agent output */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <Bot className="h-4 w-4" /> Agent output
        </h2>
        {agentOutput.length === 0 ? (
          <p className="text-sm text-gray-500">No probes yet — runs every 15 min during active hours.</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {agentOutput.map((a) => (
              <Card key={a.userId}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">User {a.userId.slice(0, 8)}…</span>
                    <Badge variant={a.stale ? "destructive" : "success"}>
                      {a.stale ? "Silent" : "Replying"}
                    </Badge>
                  </div>
                  <div className="text-xs text-gray-500 space-y-0.5">
                    <div>
                      Scheduler triggers (lookback): <span className="font-mono">{a.system_inbound_lookback}</span>
                    </div>
                    <div>
                      Last agent reply:{" "}
                      {a.last_agent_outbound_at ? (
                        <span>
                          {fmtSince(a.last_agent_outbound_at)} (
                          <span className="font-mono">{fmtAgeHours(a.hours_since_last_outbound)}</span>)
                        </span>
                      ) : (
                        "never"
                      )}
                    </div>
                    <div>Probe: {fmtSince(a.checked_at)}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Phone liveness */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <Smartphone className="h-4 w-4" /> Phone liveness
        </h2>
        {phones.length === 0 ? (
          <p className="text-sm text-gray-500">No probes yet — runs every 15 min during active hours.</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {phones.map((p) => (
              <Card key={p.userId}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">User {p.userId.slice(0, 8)}…</span>
                    <Badge variant={p.stale ? "destructive" : "success"}>
                      {p.stale ? "Silent" : "Alive"}
                    </Badge>
                  </div>
                  <div className="text-xs text-gray-500 space-y-0.5">
                    <div>
                      Last signal:{" "}
                      {p.last_signal_at ? (
                        <span>
                          {fmtSince(p.last_signal_at)} (
                          <span className="font-mono">{fmtAgeHours(p.last_signal_age_hours)}</span>)
                        </span>
                      ) : (
                        "never"
                      )}
                    </div>
                    <div>Last GPS: {fmtSince(p.last_location_at)}</div>
                    <div>Last phone_status: {fmtSince(p.last_status_at)}</div>
                    <div>Probe: {fmtSince(p.checked_at)}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
