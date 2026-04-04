"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RefreshCw, ArrowLeft } from "lucide-react";
import Link from "next/link";
import {
  fetchCalendarConfigs,
  updateCalendarAccessMode,
  fetchGoogleConnectionStatus,
  getGoogleAuthUrl,
  type CalendarConfig,
} from "../calendar-server-actions";

function getSourceLabel(cal: CalendarConfig): { label: string; className: string } {
  if (cal.role === "tickler") {
    return { label: "Tickler", className: "bg-amber-50 text-amber-700 border-amber-200" };
  }
  if (cal.source === "phone") {
    return { label: "Phone", className: "bg-purple-50 text-purple-700 border-purple-200" };
  }
  return { label: "Google", className: "bg-blue-50 text-blue-700 border-blue-200" };
}

function getAccessRoleLabel(role?: string): string | null {
  if (!role) return null;
  const map: Record<string, string> = {
    owner: "owner",
    writer: "writer",
    reader: "reader",
    freeBusyReader: "free/busy",
  };
  return map[role] ?? role;
}

export function CalendarSettingsView() {
  const [configs, setConfigs] = useState<CalendarConfig[]>([]);
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{ connected: boolean; expires_at?: string } | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, startConnect] = useTransition();

  const loadConfigs = useCallback(() => {
    setIsRefreshing(true);
    startTransition(async () => {
      const [cfgs, status] = await Promise.all([
        fetchCalendarConfigs(true),
        fetchGoogleConnectionStatus(),
      ]);
      setConfigs(cfgs);
      setConnectionStatus(status);
      setIsRefreshing(false);
    });
  }, []);

  useEffect(() => { loadConfigs(); }, [loadConfigs]);

  function handleAccessModeUpdate(calendarId: string, mode: "ignore" | "read" | "readwrite") {
    setConfigs((prev) =>
      prev.map((c) => c.calendar_id === calendarId ? { ...c, access_mode: mode } : c)
    );
    startTransition(async () => {
      await updateCalendarAccessMode(calendarId, mode);
    });
  }

  function handleReconnect() {
    setConnectError(null);
    startConnect(async () => {
      const result = await getGoogleAuthUrl();
      if (result.auth_url) {
        window.open(result.auth_url, '_blank');
        setTimeout(() => {
          startConnect(async () => {
            const s = await fetchGoogleConnectionStatus();
            setConnectionStatus(s);
            loadConfigs();
          });
        }, 10000);
      } else {
        setConnectError(result.error ?? "Failed to get auth URL");
      }
    });
  }

  const modes = ["ignore", "read", "readwrite"] as const;
  const modeLabels = { ignore: "Ignore", read: "Read", readwrite: "R/W" };
  const modeColors = { ignore: "text-gray-400", read: "text-blue-600", readwrite: "text-green-600" };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/calendar">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Calendar Settings</h1>
            <p className="text-sm text-gray-500 mt-1">Google account and calendar sources</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={loadConfigs} disabled={isPending}>
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Google Account */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-500">Google Account</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${connectionStatus?.connected ? 'bg-green-500' : 'bg-red-400'}`} />
              <span className="text-sm">{connectionStatus?.connected ? 'Connected' : 'Not connected'}</span>
              {connectionStatus?.expires_at && (
                <span className="text-xs text-gray-400">
                  expires {new Date(connectionStatus.expires_at).toLocaleDateString()}
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleReconnect} disabled={connecting}>
              {connecting ? 'Connecting...' : connectionStatus?.connected ? 'Reconnect' : 'Connect'}
            </Button>
          </div>
          {connectError && <p className="text-xs text-red-600 mt-2">{connectError}</p>}
        </CardContent>
      </Card>

      {/* Calendar Sources */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-gray-500">Calendar Sources</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={loadConfigs}
              disabled={isRefreshing}
              className="h-7 px-2 text-xs text-gray-500"
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${isRefreshing ? "animate-spin" : ""}`} />
              Sync
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {configs.map((cal) => {
              const source = getSourceLabel(cal);
              const accessRole = getAccessRoleLabel(cal.google_access_role);
              return (
                <div key={cal.calendar_id} className="flex items-center justify-between gap-2 py-2 border-b border-gray-50 last:border-0">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: cal.color || "#4285f4" }} />
                    <span className="text-sm truncate" title={cal.name}>{cal.name}</span>
                    {cal.primary && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 border-gray-300 text-gray-500 shrink-0">primary</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${source.className}`}>{source.label}</Badge>
                    {accessRole && source.label === "Google" && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 border-gray-200 text-gray-400">{accessRole}</Badge>
                    )}
                    <div className="flex items-center rounded-md border border-gray-200 p-0.5">
                      {modes.map((mode) => (
                        <button
                          key={mode}
                          onClick={() => handleAccessModeUpdate(cal.calendar_id, mode)}
                          className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                            cal.access_mode === mode ? `bg-gray-100 ${modeColors[mode]}` : "text-gray-400 hover:text-gray-600"
                          }`}
                        >
                          {modeLabels[mode]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {configs.length === 0 && (
            <p className="text-sm text-gray-400">No calendars configured. Click Sync to load from Google.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
