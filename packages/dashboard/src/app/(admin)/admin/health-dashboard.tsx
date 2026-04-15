"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, AlertTriangle } from "lucide-react";
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

function fmtAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
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
  const unhealthyCount = snapshot?.summary.services_unhealthy ?? 0;
  const staleCount = snapshot?.summary.channels_stale ?? 0;
  const pgHealthy = snapshot?.databases.postgres.healthy ?? false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm text-gray-500">
            {lastChecked
              ? `Last checked: ${lastChecked.toLocaleTimeString()}`
              : "Checking..."}
          </p>
          {(unhealthyCount > 0 || staleCount > 0) && (
            <div className="flex items-center gap-2 mt-1 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4" />
              {unhealthyCount > 0 && <span>{unhealthyCount} service(s) down</span>}
              {staleCount > 0 && <span>{staleCount} channel(s) stalled</span>}
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Services</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {services.map((svc) => (
            <Card key={svc.name}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">
                    {DISPLAY_NAMES[svc.name] ?? svc.name}
                  </span>
                  <Badge variant={svc.healthy ? "success" : "destructive"}>
                    {svc.healthy ? "Healthy" : "Down"}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`h-3 w-3 rounded-full ${svc.healthy ? "bg-green-500" : "bg-red-500"}`}
                  />
                  <span className="text-xs text-gray-500">{svc.responseTime}ms</span>
                </div>
              </CardContent>
            </Card>
          ))}
          {services.length === 0 && (
            <div className="text-sm text-gray-500 col-span-4">No service data yet.</div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Databases</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center justify-between">
              <span className="text-sm font-medium">PostgreSQL</span>
              <Badge variant={pgHealthy ? "success" : "destructive"}>
                {pgHealthy ? "Healthy" : "Down"}
              </Badge>
            </CardContent>
          </Card>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Channel bridge liveness</h2>
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
                    <div>Pending inbound: {c.pending_inbound}</div>
                    <div>
                      Oldest pending:{" "}
                      {fmtAge(c.oldest_pending_age_seconds)}
                    </div>
                    <div>
                      Last assistant reply:{" "}
                      {c.last_outbound_at
                        ? new Date(c.last_outbound_at).toLocaleTimeString()
                        : "never"}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
