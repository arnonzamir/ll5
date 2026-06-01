"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  RefreshCw,
  Tag,
  Smartphone,
  Tablet,
  Watch,
  HelpCircle,
  MapPin,
  Battery,
  Crosshair,
  Clock,
  ExternalLink,
} from "lucide-react";
import {
  fetchTrackedDevices,
  type TrackedDevice,
} from "./tracked-devices-server-actions";

const TYPE_ICON: Record<TrackedDevice["device_type"], React.ComponentType<{ className?: string }>> = {
  phone: Smartphone,
  tablet: Tablet,
  watch: Watch,
  tracker: Tag,
  unknown: HelpCircle,
};

const FRESHNESS_STYLE: Record<TrackedDevice["freshness"], string> = {
  live: "bg-green-100 text-green-700",
  recent: "bg-blue-100 text-blue-700",
  stale: "bg-amber-100 text-amber-700",
  unknown: "bg-gray-100 text-gray-500",
};

function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${minutes % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

export function TrackedDevicesView() {
  const [devices, setDevices] = useState<TrackedDevice[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setDevices(await fetchTrackedDevices());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Tracked Devices</h1>
          <p className="text-sm text-gray-500 mt-1">
            Bluetooth trackers and devices located via the Google Find Hub network. Locations are
            crowd-sourced — a tracker only updates when a nearby Android device sees it, so check
            freshness.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading && devices.length === 0 ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : devices.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-400">
            No tracked devices yet. They appear once the Find Hub poller reports a location.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {devices.map((d) => {
            const Icon = TYPE_ICON[d.device_type] ?? HelpCircle;
            return (
              <Card key={d.name}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Icon className="h-5 w-5 shrink-0 text-blue-500 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium truncate">{d.name}</div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${FRESHNESS_STYLE[d.freshness]}`}>
                          {d.freshness}
                        </span>
                      </div>

                      <div className="mt-1 flex items-center gap-1.5 text-sm">
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                        <span className="truncate">{d.place}</span>
                      </div>
                      {d.address && d.address !== d.place && (
                        <div className="text-xs text-gray-400 truncate ml-5">{d.address}</div>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                        <span className="flex items-center gap-1" title="When the Find Hub network last located it">
                          <Clock className="h-3.5 w-3.5" /> located {formatAge(d.age_minutes)}
                        </span>
                        {d.since_update_minutes != null && (
                          <span className="flex items-center gap-1" title="When the poller last checked">
                            <RefreshCw className="h-3.5 w-3.5" /> checked {formatAge(d.since_update_minutes)}
                          </span>
                        )}
                        {d.accuracy_m != null && (
                          <span className="flex items-center gap-1">
                            <Crosshair className="h-3.5 w-3.5" /> ±{Math.round(d.accuracy_m)}m
                          </span>
                        )}
                        {d.battery_pct != null && (
                          <span className="flex items-center gap-1">
                            <Battery className="h-3.5 w-3.5" /> {Math.round(d.battery_pct)}%
                          </span>
                        )}
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${d.location.lat},${d.location.lon}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-blue-500 hover:underline"
                        >
                          <ExternalLink className="h-3.5 w-3.5" /> Map
                        </a>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
