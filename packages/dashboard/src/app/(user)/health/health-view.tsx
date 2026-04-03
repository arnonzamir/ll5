"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  RefreshCw,
  Moon,
  Heart,
  Activity,
  Footprints,
  Scale,
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
  Brain,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import Link from "next/link";
import {
  fetchHealthSources,
  fetchSleepSummary,
  fetchHeartRate,
  fetchDailyStats,
  fetchActivities,
  fetchBodyComposition,
  fetchHealthTrend,
  type HealthSource,
  type SleepSummary,
  type HeartRateRecord,
  type DailyStats,
  type ActivityRecord,
  type BodyCompositionRecord,
  type TrendData,
} from "./health-server-actions";

type TabId = "overview" | "sleep" | "heart_rate" | "daily" | "activities" | "body";

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return formatDate(new Date());
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatTime(iso: string): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function TrendBadge({ trend }: { trend: TrendData | null }) {
  if (!trend || trend.direction == null) return null;
  const icons = { up: TrendingUp, down: TrendingDown, stable: Minus };
  const colors = {
    up: "text-green-600",
    down: "text-red-600",
    stable: "text-gray-500",
  };
  const Icon = icons[trend.direction];
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs ${colors[trend.direction]}`}>
      <Icon className="h-3 w-3" />
      {trend.changePct != null ? `${Math.abs(trend.changePct)}%` : ""}
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  trend,
  icon: Icon,
}: {
  label: string;
  value: string | number | null;
  sub?: string;
  trend?: TrendData | null;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className="text-xl font-semibold">
              {value ?? "-"}
            </p>
            {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
          </div>
          <div className="flex flex-col items-end gap-1">
            {Icon && <Icon className="h-4 w-4 text-gray-400" />}
            <TrendBadge trend={trend ?? null} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SleepStageBar({ stages }: { stages: SleepSummary["stages"] }) {
  const total = stages.deepSeconds + stages.lightSeconds + stages.remSeconds + stages.awakeSeconds;
  if (total === 0) return null;
  const segments = [
    { label: "Deep", pct: stages.deepPct, color: "bg-indigo-600" },
    { label: "Light", pct: stages.lightPct, color: "bg-blue-400" },
    { label: "REM", pct: stages.remPct, color: "bg-purple-500" },
    { label: "Awake", pct: stages.awakePct, color: "bg-orange-400" },
  ];
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden">
        {segments.map((s) => (
          <div key={s.label} className={`${s.color}`} style={{ width: `${s.pct}%` }} title={`${s.label}: ${s.pct}%`} />
        ))}
      </div>
      <div className="flex gap-3 flex-wrap">
        {segments.map((s) => (
          <span key={s.label} className="flex items-center gap-1 text-xs text-gray-600">
            <span className={`inline-block w-2 h-2 rounded-full ${s.color}`} />
            {s.label} {s.pct}%
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- Overview Tab ----------

function OverviewTab({
  dailyStats,
  sleep,
  heartRate,
  trends,
  isPending,
}: {
  dailyStats: DailyStats | null;
  sleep: SleepSummary | null;
  heartRate: HeartRateRecord | null;
  trends: Record<string, TrendData | null>;
  isPending: boolean;
}) {
  if (isPending) return <p className="text-sm text-gray-400 text-center py-8">Loading...</p>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard
          label="Steps"
          value={dailyStats?.steps?.toLocaleString() ?? null}
          sub={dailyStats?.distanceKm != null ? `${dailyStats.distanceKm} km` : undefined}
          trend={trends.steps}
          icon={Footprints}
        />
        <StatCard
          label="Sleep"
          value={sleep ? `${sleep.durationHours}h` : null}
          sub={sleep ? `Quality: ${sleep.qualityScore}` : undefined}
          trend={trends.sleep_duration}
          icon={Moon}
        />
        <StatCard
          label="Resting HR"
          value={heartRate?.restingHr ?? null}
          sub={heartRate ? `${heartRate.minHr}-${heartRate.maxHr} bpm` : undefined}
          trend={trends.resting_hr}
          icon={Heart}
        />
        <StatCard
          label="Active Calories"
          value={dailyStats?.activeCalories?.toLocaleString() ?? null}
          sub={dailyStats?.totalCalories ? `Total: ${dailyStats.totalCalories.toLocaleString()}` : undefined}
          trend={trends.active_calories}
          icon={Activity}
        />
        <StatCard
          label="Stress"
          value={dailyStats?.stress?.average ?? null}
          sub={dailyStats?.stress?.max != null ? `Max: ${dailyStats.stress.max}` : undefined}
          trend={trends.stress}
          icon={Brain}
        />
        <StatCard
          label="Energy"
          value={dailyStats?.energy?.level ?? null}
          sub={
            dailyStats?.energy?.min != null && dailyStats?.energy?.max != null
              ? `${dailyStats.energy.min}-${dailyStats.energy.max}`
              : undefined
          }
          trend={trends.energy}
          icon={Zap}
        />
        <StatCard
          label="Active Time"
          value={dailyStats?.activeMinutes != null ? `${dailyStats.activeMinutes}m` : null}
          icon={Activity}
        />
        <StatCard
          label="Floors"
          value={dailyStats?.floorsClimbed ?? null}
        />
      </div>

      {sleep && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Moon className="h-4 w-4" /> Sleep Stages
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SleepStageBar stages={sleep.stages} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------- Sleep Tab ----------

function SleepTab({ date, isPending }: { date: string; isPending: boolean }) {
  const [sleep, setSleep] = useState<SleepSummary | null>(null);
  const [loading, startLoad] = useTransition();

  const load = useCallback(() => {
    startLoad(async () => {
      const data = await fetchSleepSummary(date);
      setSleep(data);
    });
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const pending = isPending || loading;

  if (pending) return <p className="text-sm text-gray-400 text-center py-8">Loading...</p>;
  if (!sleep) return <p className="text-sm text-gray-400 text-center py-8">No sleep data for {date}</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Duration" value={`${sleep.durationHours}h`} sub={formatDuration(sleep.durationSeconds)} icon={Moon} />
        <StatCard label="Quality Score" value={sleep.qualityScore} />
        <StatCard label="Bedtime" value={formatTime(sleep.sleepTime)} />
        <StatCard label="Wake Time" value={formatTime(sleep.wakeTime)} />
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Sleep Stages</CardTitle></CardHeader>
        <CardContent>
          <SleepStageBar stages={sleep.stages} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <div><p className="text-xs text-gray-500">Deep</p><p className="text-sm font-medium">{formatDuration(sleep.stages.deepSeconds)}</p></div>
            <div><p className="text-xs text-gray-500">Light</p><p className="text-sm font-medium">{formatDuration(sleep.stages.lightSeconds)}</p></div>
            <div><p className="text-xs text-gray-500">REM</p><p className="text-sm font-medium">{formatDuration(sleep.stages.remSeconds)}</p></div>
            <div><p className="text-xs text-gray-500">Awake</p><p className="text-sm font-medium">{formatDuration(sleep.stages.awakeSeconds)}</p></div>
          </div>
        </CardContent>
      </Card>

      {(sleep.averageHr || sleep.lowestHr || sleep.highestHr) && (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Avg HR" value={sleep.averageHr} icon={Heart} />
          <StatCard label="Lowest HR" value={sleep.lowestHr} />
          <StatCard label="Highest HR" value={sleep.highestHr} />
        </div>
      )}
    </div>
  );
}

// ---------- Heart Rate Tab ----------

function HeartRateTab({ date, isPending }: { date: string; isPending: boolean }) {
  const [hr, setHr] = useState<HeartRateRecord | null>(null);
  const [loading, startLoad] = useTransition();

  const load = useCallback(() => {
    startLoad(async () => {
      const data = await fetchHeartRate({ date });
      if (data && !Array.isArray(data)) setHr(data);
      else if (Array.isArray(data) && data.length > 0) setHr(data[0]);
      else setHr(null);
    });
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const pending = isPending || loading;
  if (pending) return <p className="text-sm text-gray-400 text-center py-8">Loading...</p>;
  if (!hr) return <p className="text-sm text-gray-400 text-center py-8">No heart rate data for {date}</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Resting HR" value={`${hr.restingHr} bpm`} icon={Heart} />
        <StatCard label="Average HR" value={`${hr.averageHr} bpm`} />
        <StatCard label="Min HR" value={`${hr.minHr} bpm`} />
        <StatCard label="Max HR" value={`${hr.maxHr} bpm`} />
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Heart Rate Zones</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[
              { label: "Rest", seconds: hr.zones.restSeconds, color: "bg-gray-400" },
              { label: "Zone 1", seconds: hr.zones.z1Seconds, color: "bg-blue-400" },
              { label: "Zone 2", seconds: hr.zones.z2Seconds, color: "bg-green-500" },
              { label: "Zone 3", seconds: hr.zones.z3Seconds, color: "bg-yellow-500" },
              { label: "Zone 4", seconds: hr.zones.z4Seconds, color: "bg-orange-500" },
              { label: "Zone 5", seconds: hr.zones.z5Seconds, color: "bg-red-500" },
            ].filter((z) => z.seconds > 0).map((z) => {
              const totalSec = hr.zones.restSeconds + hr.zones.z1Seconds + hr.zones.z2Seconds + hr.zones.z3Seconds + hr.zones.z4Seconds + hr.zones.z5Seconds;
              const pct = totalSec > 0 ? Math.round((z.seconds / totalSec) * 100) : 0;
              return (
                <div key={z.label} className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-14">{z.label}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-2.5">
                    <div className={`${z.color} h-2.5 rounded-full`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-500 w-16 text-right">{formatDuration(z.seconds)}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Daily Stats Tab ----------

function DailyStatsTab({ date, isPending }: { date: string; isPending: boolean }) {
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [loading, startLoad] = useTransition();

  const load = useCallback(() => {
    startLoad(async () => {
      const data = await fetchDailyStats(date);
      setStats(data);
    });
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const pending = isPending || loading;
  if (pending) return <p className="text-sm text-gray-400 text-center py-8">Loading...</p>;
  if (!stats) return <p className="text-sm text-gray-400 text-center py-8">No daily stats for {date}</p>;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      <StatCard label="Steps" value={stats.steps?.toLocaleString()} icon={Footprints} />
      <StatCard label="Distance" value={stats.distanceKm != null ? `${stats.distanceKm} km` : null} />
      <StatCard label="Floors Climbed" value={stats.floorsClimbed} />
      <StatCard label="Active Calories" value={stats.activeCalories?.toLocaleString()} icon={Activity} />
      <StatCard label="Total Calories" value={stats.totalCalories?.toLocaleString()} />
      <StatCard label="Active Time" value={stats.activeMinutes != null ? `${stats.activeMinutes} min` : null} />
      <StatCard label="Stress Avg" value={stats.stress?.average} sub={stats.stress?.max != null ? `Max: ${stats.stress.max}` : undefined} icon={Brain} />
      <StatCard label="Energy" value={stats.energy?.level} sub={stats.energy?.min != null ? `${stats.energy.min}-${stats.energy.max}` : undefined} icon={Zap} />
    </div>
  );
}

// ---------- Activities Tab ----------

function ActivitiesTab({ date }: { date: string }) {
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [loading, startLoad] = useTransition();

  const from = addDays(date, -6);

  const load = useCallback(() => {
    startLoad(async () => {
      const data = await fetchActivities({ from, to: date, limit: 20 });
      setActivities(data);
    });
  }, [from, date]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-gray-400 text-center py-8">Loading...</p>;
  if (activities.length === 0) return <p className="text-sm text-gray-400 text-center py-8">No activities in the last 7 days</p>;

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {activities.map((a, i) => (
        <div key={`${a.sourceId}-${i}`} className="border-b border-gray-100 last:border-0 px-4 py-3 hover:bg-gray-50/50">
          <div className="flex items-start justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{a.name || a.activityType}</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">{a.activityType}</Badge>
              </div>
              <p className="text-xs text-gray-500">
                {new Date(a.startTime).toLocaleDateString()} {formatTime(a.startTime)}
                {a.durationMinutes != null && ` \u00b7 ${a.durationMinutes} min`}
              </p>
            </div>
            <div className="text-right text-xs text-gray-500 space-y-0.5">
              {a.distanceKm != null && <p>{a.distanceKm} km</p>}
              {a.calories != null && <p>{a.calories} cal</p>}
              {a.averageHr != null && <p>{a.averageHr} bpm avg</p>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Body Composition Tab ----------

function BodyCompositionTab({ date }: { date: string }) {
  const [current, setCurrent] = useState<BodyCompositionRecord | null>(null);
  const [history, setHistory] = useState<BodyCompositionRecord[]>([]);
  const [weightTrend, setWeightTrend] = useState<TrendData | null>(null);
  const [loading, startLoad] = useTransition();

  const from = addDays(date, -30);

  const load = useCallback(() => {
    startLoad(async () => {
      const [latest, range, trend] = await Promise.all([
        fetchBodyComposition(),
        fetchBodyComposition({ from, to: date }),
        fetchHealthTrend("weight", "month"),
      ]);
      if (latest && !Array.isArray(latest)) setCurrent(latest);
      if (Array.isArray(range)) setHistory(range);
      setWeightTrend(trend);
    });
  }, [from, date]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-gray-400 text-center py-8">Loading...</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Weight"
          value={current?.weightKg != null ? `${current.weightKg} kg` : null}
          trend={weightTrend}
          icon={Scale}
        />
        <StatCard label="Body Fat" value={current?.bodyFatPct != null ? `${current.bodyFatPct}%` : null} />
        <StatCard label="Muscle Mass" value={current?.muscleMassKg != null ? `${current.muscleMassKg} kg` : null} />
        <StatCard label="BMI" value={current?.bmi != null ? `${current.bmi}` : null} />
      </div>

      {history.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Weight History (30 days)</CardTitle>
            <CardDescription className="text-xs">{history.length} measurements</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              {history.map((r, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2 border-b border-gray-100 last:border-0 text-sm hover:bg-gray-50/50">
                  <span className="text-gray-600">{r.date}</span>
                  <span className="font-medium">{r.weightKg != null ? `${r.weightKg} kg` : "-"}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------- Main View ----------

const TABS: { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "sleep", label: "Sleep", icon: Moon },
  { id: "heart_rate", label: "Heart Rate", icon: Heart },
  { id: "daily", label: "Daily Stats", icon: Footprints },
  { id: "activities", label: "Activities", icon: Activity },
  { id: "body", label: "Body", icon: Scale },
];

export function HealthView() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [date, setDate] = useState(today());
  const [isPending, startTransition] = useTransition();
  const [sources, setSources] = useState<HealthSource[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);

  // Overview data
  const [dailyStats, setDailyStats] = useState<DailyStats | null>(null);
  const [sleep, setSleep] = useState<SleepSummary | null>(null);
  const [heartRate, setHeartRate] = useState<HeartRateRecord | null>(null);
  const [trends, setTrends] = useState<Record<string, TrendData | null>>({});

  const loadOverview = useCallback(() => {
    startTransition(async () => {
      const [srcList, stats, slp, hr, ...trendResults] = await Promise.all([
        fetchHealthSources(),
        fetchDailyStats(date),
        fetchSleepSummary(date),
        fetchHeartRate({ date }),
        fetchHealthTrend("steps", "week"),
        fetchHealthTrend("sleep_duration", "week"),
        fetchHealthTrend("resting_hr", "week"),
        fetchHealthTrend("active_calories", "week"),
        fetchHealthTrend("stress", "week"),
        fetchHealthTrend("energy", "week"),
      ]);

      setSources(srcList);
      setSourcesLoaded(true);
      setDailyStats(stats);
      setSleep(slp);
      if (hr && !Array.isArray(hr)) setHeartRate(hr);
      else if (Array.isArray(hr) && hr.length > 0) setHeartRate(hr[0]);
      else setHeartRate(null);

      const trendKeys = ["steps", "sleep_duration", "resting_hr", "active_calories", "stress", "energy"];
      const trendMap: Record<string, TrendData | null> = {};
      trendKeys.forEach((k, i) => { trendMap[k] = trendResults[i]; });
      setTrends(trendMap);
    });
  }, [date]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const connectedSources = sources.filter((s) => s.connected);
  const hasConnected = connectedSources.length > 0;

  // Not configured state
  if (sourcesLoaded && !hasConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Heart className="h-12 w-12 text-gray-300 mb-4" />
        <h2 className="text-lg font-semibold text-gray-700 mb-2">Health Monitoring Not Configured</h2>
        <p className="text-sm text-gray-500 mb-6 text-center max-w-md">
          Connect a health data source to start tracking your sleep, heart rate, activities, and more.
        </p>
        <Link href="/settings/health">
          <Button>
            <Settings className="h-4 w-4 mr-2" />
            Configure Health Sources
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Health</h1>
          <p className="text-sm text-gray-500 mt-1">
            {connectedSources.map((s) => s.displayName).join(", ")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Date navigator */}
          <div className="flex items-center gap-1 border border-gray-200 rounded-md">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDate(addDays(date, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border-0 h-8 w-32 text-center text-sm"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setDate(addDays(date, 1))}
              disabled={date >= today()}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Link href="/settings/health">
            <Button variant="outline" size="icon" className="h-8 w-8" title="Health Settings">
              <Settings className="h-4 w-4" />
            </Button>
          </Link>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadOverview} disabled={isPending}>
            <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 mb-4 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <OverviewTab dailyStats={dailyStats} sleep={sleep} heartRate={heartRate} trends={trends} isPending={isPending} />
      )}
      {activeTab === "sleep" && <SleepTab date={date} isPending={isPending} />}
      {activeTab === "heart_rate" && <HeartRateTab date={date} isPending={isPending} />}
      {activeTab === "daily" && <DailyStatsTab date={date} isPending={isPending} />}
      {activeTab === "activities" && <ActivitiesTab date={date} />}
      {activeTab === "body" && <BodyCompositionTab date={date} />}
    </div>
  );
}
