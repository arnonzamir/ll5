"use client";

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, X } from "lucide-react";

interface SystemAlert {
  alert_key: string;
  severity: "warning" | "critical";
  summary: string;
  metric_value?: string | null;
  expected?: string | null;
  suggestion?: string | null;
  first_seen_at: string;
}

function firingFor(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

const POLL_MS = 45_000;

/**
 * Global system-health alert banner. Polls /api/alerts and shows a bar per
 * firing alert (red = critical, amber = warning). Per-session dismiss, but a
 * still-firing alert reappears on the next poll so it can't be permanently
 * hidden while the underlying problem persists.
 */
export function AlertsBanner() {
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { alerts?: SystemAlert[] };
      setAlerts(Array.isArray(data.alerts) ? data.alerts : []);
    } catch {
      /* keep last known */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // A dismissal hides the alert until its first_seen_at advances (a new episode)
  // or ~10 min passes — so a persistent outage resurfaces.
  const now = Date.now();
  const visible = alerts.filter((a) => {
    const at = dismissed[a.alert_key];
    return !at || now - at > 10 * 60_000;
  });

  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col">
      {visible.map((a) => {
        const critical = a.severity === "critical";
        return (
          <div
            key={a.alert_key}
            className={`flex items-start gap-3 px-4 py-2 text-sm border-b ${
              critical
                ? "bg-red-600 text-white border-red-700"
                : "bg-amber-400 text-amber-950 border-amber-500"
            }`}
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="font-semibold">{a.summary}</span>
              {a.metric_value ? <span className="opacity-90"> — {a.metric_value}</span> : null}
              <span className="opacity-80">
                {" "}· firing {firingFor(a.first_seen_at)}
                {a.expected ? ` · expected ${a.expected}` : ""}
              </span>
              {a.suggestion ? (
                <div className={`text-xs mt-0.5 ${critical ? "text-red-100" : "text-amber-900"}`}>
                  {a.suggestion}
                </div>
              ) : null}
            </div>
            <button
              aria-label="Dismiss"
              onClick={() => setDismissed((d) => ({ ...d, [a.alert_key]: Date.now() }))}
              className={`shrink-0 rounded p-0.5 ${critical ? "hover:bg-red-700" : "hover:bg-amber-500"}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
