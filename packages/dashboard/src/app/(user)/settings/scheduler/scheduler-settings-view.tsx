"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, ArrowLeft, CheckCircle2, Clock, Bell, Calendar } from "lucide-react";
import Link from "next/link";
import {
  fetchSchedulerSettings,
  updateSchedulerSettings,
  DEFAULTS,
  type SchedulerSettings,
} from "./scheduler-server-actions";

function NumberField({
  label,
  description,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string;
  description?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex-1">
        <Label className="text-sm">{label}</Label>
        {description && <p className="text-xs text-gray-400">{description}</p>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value) || 0)}
          min={min}
          max={max}
          className="w-20 h-8 text-center text-sm"
        />
        {suffix && <span className="text-xs text-gray-400 w-8">{suffix}</span>}
      </div>
    </div>
  );
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function SchedulerSettingsView() {
  const [settings, setSettings] = useState<SchedulerSettings>(DEFAULTS);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await fetchSchedulerSettings();
      if (result.error) setError(result.error);
      setSettings(result.settings);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleSave() {
    setSaved(false);
    setError(null);
    startTransition(async () => {
      const result = await updateSchedulerSettings(settings);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(result.error ?? "Failed to save");
      }
    });
  }

  function update(key: keyof SchedulerSettings, value: number) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/dashboard">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Scheduler Settings</h1>
            <p className="text-sm text-gray-500 mt-1">
              Configure agent proactivity intervals. Changes take effect on gateway restart.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={isPending}>
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="space-y-4 max-w-2xl">
        {/* Active Hours */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4" /> Active Hours
            </CardTitle>
            <CardDescription className="text-xs">Schedulers only fire during these hours</CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-gray-50">
            <NumberField label="Start hour" value={settings.active_hours_start} onChange={(v) => update("active_hours_start", v)} min={0} max={23} suffix="h" />
            <NumberField label="End hour" value={settings.active_hours_end} onChange={(v) => update("active_hours_end", v)} min={0} max={23} suffix="h" />
          </CardContent>
        </Card>

        {/* Reviews */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Calendar className="h-4 w-4" /> Reviews
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-gray-50">
            <NumberField label="Morning briefing hour" value={settings.morning_briefing_hour} onChange={(v) => update("morning_briefing_hour", v)} min={0} max={23} suffix="h" />
            <NumberField label="Calendar review interval" value={settings.calendar_review_minutes} onChange={(v) => update("calendar_review_minutes", v)} min={15} suffix="min" />
            <div className="flex items-center justify-between gap-4 py-2">
              <div className="flex-1">
                <Label className="text-sm">Weekly review day</Label>
              </div>
              <Select value={String(settings.weekly_review_day)} onValueChange={(v) => update("weekly_review_day", parseInt(v))}>
                <SelectTrigger className="w-32 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_NAMES.map((name, i) => (
                    <SelectItem key={i} value={String(i)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <NumberField label="Weekly review hour" value={settings.weekly_review_hour} onChange={(v) => update("weekly_review_hour", v)} min={0} max={23} suffix="h" />
          </CardContent>
        </Card>

        {/* Alerts & Nudges */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Bell className="h-4 w-4" /> Alerts & Nudges
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-gray-50">
            <NumberField label="Heartbeat silence threshold" description="Nudge agent after this many minutes of silence" value={settings.heartbeat_silence_minutes} onChange={(v) => update("heartbeat_silence_minutes", v)} min={5} suffix="min" />
            <NumberField label="Journal nudge threshold" description="Remind agent to journal after this interval" value={settings.journal_nudge_minutes} onChange={(v) => update("journal_nudge_minutes", v)} min={15} suffix="min" />
            <NumberField label="Tickler alert interval" value={settings.tickler_alert_minutes} onChange={(v) => update("tickler_alert_minutes", v)} min={15} suffix="min" />
            <NumberField label="Tickler look-ahead window" value={settings.tickler_lookahead_hours} onChange={(v) => update("tickler_lookahead_hours", v)} min={1} max={12} suffix="h" />
            <NumberField label="Schedule lookback" description="How far back to show events in heartbeat" value={settings.schedule_lookback_hours} onChange={(v) => update("schedule_lookback_hours", v)} min={0} max={6} suffix="h" />
            <NumberField label="Schedule lookahead" description="How far ahead to show events in heartbeat" value={settings.schedule_lookahead_hours} onChange={(v) => update("schedule_lookahead_hours", v)} min={1} max={12} suffix="h" />
          </CardContent>
        </Card>

        {/* Background */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Background Tasks</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-gray-50">
            <NumberField label="GTD health check interval" value={settings.gtd_health_hours} onChange={(v) => update("gtd_health_hours", v)} min={1} max={24} suffix="h" />
            <NumberField label="Message batch review interval" value={settings.message_batch_minutes} onChange={(v) => update("message_batch_minutes", v)} min={10} suffix="min" />
            <NumberField label="Journal consolidation hour" description="Nightly consolidation trigger" value={settings.consolidation_hour} onChange={(v) => update("consolidation_hour", v)} min={0} max={23} suffix="h" />
          </CardContent>
        </Card>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{error}</div>
        )}

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
    </div>
  );
}
