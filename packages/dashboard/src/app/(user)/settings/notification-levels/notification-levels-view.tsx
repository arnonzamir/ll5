"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  RefreshCw,
  Bell,
  BellRing,
  BellOff,
  AlertTriangle,
  Moon,
  CheckCircle2,
  ArrowLeft,
} from "lucide-react";
import Link from "next/link";
import {
  fetchNotificationSettings,
  updateNotificationSettings,
  type NotificationSettings,
} from "./notification-levels-server-actions";

type Level = "silent" | "notify" | "alert" | "critical";

const LEVELS: { id: Level; label: string; icon: React.ComponentType<{ className?: string }>; description: string; color: string }[] = [
  {
    id: "silent",
    label: "Silent",
    icon: BellOff,
    description: "Notification shade + badge, no sound or vibration. For FYI items.",
    color: "text-gray-500",
  },
  {
    id: "notify",
    label: "Notify",
    icon: Bell,
    description: "Sound or soft vibration. For contextual on-the-go updates.",
    color: "text-blue-600",
  },
  {
    id: "alert",
    label: "Alert",
    icon: BellRing,
    description: "Strong sound + vibration + heads-up popup. For urgent messages.",
    color: "text-amber-600",
  },
  {
    id: "critical",
    label: "Critical",
    icon: AlertTriangle,
    description: "Override DND, persistent. For emergencies only.",
    color: "text-red-600",
  },
];

function LevelSelector({
  value,
  onChange,
  label,
  description,
}: {
  value: Level;
  onChange: (v: Level) => void;
  label: string;
  description: string;
}) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-gray-500">{description}</p>
      </div>
      <div className="flex gap-1">
        {LEVELS.map((level) => {
          const Icon = level.icon;
          const isActive = value === level.id;
          const levelIndex = LEVELS.findIndex((l) => l.id === level.id);
          const selectedIndex = LEVELS.findIndex((l) => l.id === value);
          const isWithin = levelIndex <= selectedIndex;
          return (
            <button
              key={level.id}
              onClick={() => onChange(level.id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                isActive
                  ? `bg-gray-900 text-white`
                  : isWithin
                    ? "bg-gray-100 text-gray-700"
                    : "bg-gray-50 text-gray-400"
              }`}
              title={level.description}
            >
              <Icon className="h-3.5 w-3.5" />
              {level.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NotificationLevelsView() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await fetchNotificationSettings();
      if (result.error) {
        setError(result.error);
      } else {
        setSettings(result.settings);
      }
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleSave() {
    if (!settings) return;
    setSaved(false);
    setError(null);
    startTransition(async () => {
      const result = await updateNotificationSettings(settings);
      if (result.ok) {
        setSaved(true);
      } else {
        setError(result.error ?? "Failed to save");
      }
    });
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/dashboard">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Notification Levels</h1>
            <p className="text-sm text-gray-500 mt-1">
              Control how your phone grabs your attention
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={isPending}>
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {!settings ? (
        <p className="text-sm text-gray-400 text-center py-8">Loading...</p>
      ) : (
        <div className="space-y-6">
          {/* Level descriptions */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">How it works</CardTitle>
              <CardDescription className="text-xs">
                The agent chooses a notification level for each push. You set the maximum level allowed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                {LEVELS.map((level) => {
                  const Icon = level.icon;
                  return (
                    <div key={level.id} className="flex items-start gap-3">
                      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${level.color}`} />
                      <div>
                        <p className="text-sm font-medium">{level.label}</p>
                        <p className="text-xs text-gray-500">{level.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Normal hours max */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Bell className="h-4 w-4" /> Maximum Level
              </CardTitle>
              <CardDescription className="text-xs">
                The agent cannot exceed this level during normal hours
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LevelSelector
                value={settings.max_level as Level}
                onChange={(v) => setSettings({ ...settings, max_level: v })}
                label="Normal hours"
                description="Maximum notification urgency the agent can use"
              />
            </CardContent>
          </Card>

          {/* Quiet hours */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Moon className="h-4 w-4" /> Quiet Hours
              </CardTitle>
              <CardDescription className="text-xs">
                Reduced notification level during quiet hours
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <LevelSelector
                value={settings.quiet_max_level as Level}
                onChange={(v) => setSettings({ ...settings, quiet_max_level: v })}
                label="Quiet hours maximum"
                description="Maximum level during quiet hours"
              />
              <div className="flex items-end gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-gray-500">Start</label>
                  <Input
                    type="time"
                    value={settings.quiet_start}
                    onChange={(e) => setSettings({ ...settings, quiet_start: e.target.value })}
                    className="w-32 h-9"
                  />
                </div>
                <span className="text-sm text-gray-400 pb-2">to</span>
                <div className="space-y-1">
                  <label className="text-xs text-gray-500">End</label>
                  <Input
                    type="time"
                    value={settings.quiet_end}
                    onChange={(e) => setSettings({ ...settings, quiet_end: e.target.value })}
                    className="w-32 h-9"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400">
                Timezone is set in your profile settings.
              </p>
            </CardContent>
          </Card>

          {/* Error display */}
          {error && (
            <div className="flex items-center gap-2 text-sm px-3 py-2 rounded-md bg-red-50 text-red-700">
              {error}
            </div>
          )}

          {/* Save button */}
          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={isPending}>
              {isPending ? "Saving..." : "Save Settings"}
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" /> Saved
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
