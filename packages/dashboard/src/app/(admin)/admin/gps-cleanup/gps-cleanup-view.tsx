"use client";

import { useState, useTransition } from "react";
import {
  scanBadGpsPoints,
  deleteGpsPoints,
  scanAndDelete,
  type BadPoint,
  type BadReason,
  type GpsScanResult,
  type TimeRange,
} from "./gps-cleanup-server-actions";
import { DEFAULT_GEO_BOUNDS } from "./gps-bounds";

type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "error"; message: string }
  | { kind: "scanned"; result: GpsScanResult; scannedAt: string };

type DeleteState =
  | { kind: "idle" }
  | { kind: "deleting" }
  | { kind: "error"; message: string }
  | { kind: "done"; deleted: number; perCriterion?: Record<BadReason, number> };

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "1d", label: "Last 24h" },
  { value: "3d", label: "Last 3 days" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

export function GpsCleanupView() {
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [del, setDel] = useState<DeleteState>({ kind: "idle" });
  const [isPending, startTransition] = useTransition();
  const [timeRange, setTimeRange] = useState<TimeRange>("3d");
  // Gap G7: geo-boundary criterion is OFF by default so the scan is safe to
  // run while/after traveling abroad. Enable it to flag out-of-bounds points.
  const [geoEnabled, setGeoEnabled] = useState(false);
  const [bounds, setBounds] = useState({
    minLat: String(DEFAULT_GEO_BOUNDS.minLat),
    maxLat: String(DEFAULT_GEO_BOUNDS.maxLat),
    minLon: String(DEFAULT_GEO_BOUNDS.minLon),
    maxLon: String(DEFAULT_GEO_BOUNDS.maxLon),
  });
  const [selected, setSelected] = useState<Set<BadReason>>(
    new Set(["speed"]),
  );

  const geoArg = () =>
    geoEnabled
      ? ({ enabled: true, bounds: parsedBounds() } as const)
      : ({ enabled: false } as const);

  // Parse the bounds inputs; fall back to defaults for any blank/invalid field.
  const parsedBounds = () => {
    const num = (s: string, fallback: number) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      minLat: num(bounds.minLat, DEFAULT_GEO_BOUNDS.minLat),
      maxLat: num(bounds.maxLat, DEFAULT_GEO_BOUNDS.maxLat),
      minLon: num(bounds.minLon, DEFAULT_GEO_BOUNDS.minLon),
      maxLon: num(bounds.maxLon, DEFAULT_GEO_BOUNDS.maxLon),
    };
  };

  const runScan = () => {
    setScan({ kind: "scanning" });
    setDel({ kind: "idle" });
    startTransition(async () => {
      const res = await scanBadGpsPoints(
        timeRange,
        geoEnabled
          ? { enabled: true, bounds: parsedBounds() }
          : { enabled: false },
      );
      if (!res.ok) {
        setScan({ kind: "error", message: res.error });
      } else {
        setScan({ kind: "scanned", result: res.result, scannedAt: new Date().toISOString() });
      }
    });
  };

  const runOneClick = () => {
    const criteria: BadReason[] = [...selected];
    if (criteria.length === 0) {
      alert("Select at least one criterion.");
      return;
    }
    if (criteria.includes("out_of_israel") && !geoEnabled) {
      alert("Enable the geo-boundary filter to delete out-of-bounds points.");
      return;
    }
    if (!confirm(`One-click: scan ${humanRange(timeRange)} and DELETE points matching [${criteria.join(", ")}]?\n\nThis runs without a preview.`)) return;

    setDel({ kind: "deleting" });
    startTransition(async () => {
      const res = await scanAndDelete(
        timeRange,
        criteria,
        geoEnabled ? parsedBounds() : undefined,
      );
      if (!res.ok) {
        setDel({ kind: "error", message: res.error });
      } else {
        setDel({ kind: "done", deleted: res.deleted, perCriterion: res.perCriterion });
        // Re-scan to show the post-delete state
        const after = await scanBadGpsPoints(timeRange, geoArg());
        if (after.ok) {
          setScan({
            kind: "scanned",
            result: after.result,
            scannedAt: new Date().toISOString(),
          });
        }
      }
    });
  };

  const idsForSelection = (result: GpsScanResult): string[] => {
    const ids = new Set<string>();
    if (selected.has("accuracy")) result.badAccuracy.forEach((p) => ids.add(p.id));
    if (selected.has("speed")) result.badSpeed.forEach((p) => ids.add(p.id));
    if (selected.has("place_drift")) result.badPlaceDrift.forEach((p) => ids.add(p.id));
    if (selected.has("out_of_israel")) result.badOutOfIsrael.forEach((p) => ids.add(p.id));
    return [...ids];
  };

  const runDelete = () => {
    if (scan.kind !== "scanned") return;
    const ids = idsForSelection(scan.result);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} GPS points? This cannot be undone.`)) return;

    setDel({ kind: "deleting" });
    startTransition(async () => {
      const res = await deleteGpsPoints(ids);
      if (!res.ok) {
        setDel({ kind: "error", message: res.error });
      } else {
        setDel({ kind: "done", deleted: res.deleted });
        const after = await scanBadGpsPoints(timeRange, geoArg());
        if (after.ok) {
          setScan({
            kind: "scanned",
            result: after.result,
            scannedAt: new Date().toISOString(),
          });
        }
      }
    });
  };

  const toggleCategory = (cat: BadReason) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-gray-700">
        <p className="font-semibold">About this tool</p>
        <p className="mt-1">
          Scans <code className="rounded bg-amber-100 px-1">ll5_awareness_locations</code> for bad
          points that the pre-2026-04-23 broken filters let through, plus an out-of-bounds check.
        </p>
        <ul className="ml-5 mt-2 list-disc space-y-0.5">
          <li><strong>Accuracy</strong> — accuracy &gt; 100 m</li>
          <li><strong>Implausible speed</strong> — &gt; 150 km/h between consecutive points within 10 min</li>
          <li><strong>Place drift</strong> — &gt; 500 m from a known-place point within 5 min</li>
          <li><strong>Outside bounds</strong> — lat/lon outside the bounding box. <em>Opt-in</em> (off by default so it never wrongly flags points while traveling abroad); enable below to use the Israel default or a custom box.</li>
        </ul>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-gray-200 bg-white p-3">
        <div>
          <label className="block text-xs text-gray-500">Time range</label>
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            {TIME_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={runScan}
          disabled={isPending}
          className="rounded-md bg-admin px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-admin-600 disabled:opacity-50"
        >
          {scan.kind === "scanning" ? "Scanning…" : "Scan (preview)"}
        </button>
        <button
          type="button"
          onClick={runOneClick}
          disabled={isPending || selected.size === 0}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-50"
          title={`Runs scan + delete for selected criteria in one call`}
        >
          {del.kind === "deleting" && scan.kind !== "scanned" ? "Running…" : "Scan & delete"}
        </button>
        {scan.kind === "scanned" && (
          <span className="text-xs text-gray-500">
            Last scan {new Date(scan.scannedAt).toLocaleTimeString()} · {humanRange(scan.result.timeRange)}
          </span>
        )}
      </div>

      {/* Gap G7: geo-boundary filter is opt-in so the scan never wrongly flags
          legitimate points while/after traveling abroad. */}
      <div className="rounded-md border border-gray-200 bg-white p-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-800">
          <input
            type="checkbox"
            checked={geoEnabled}
            onChange={(e) => {
              const on = e.target.checked;
              setGeoEnabled(on);
              // Keep the criterion selection in sync with the filter toggle.
              setSelected((prev) => {
                const next = new Set(prev);
                if (on) next.add("out_of_israel");
                else next.delete("out_of_israel");
                return next;
              });
            }}
          />
          Enable geo-boundary filter (flag points outside the bounding box)
        </label>
        {geoEnabled && (
          <div className="mt-3 flex flex-wrap gap-3">
            {(
              [
                ["minLat", "Min lat"],
                ["maxLat", "Max lat"],
                ["minLon", "Min lon"],
                ["maxLon", "Max lon"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <label className="block text-xs text-gray-500">{label}</label>
                <input
                  type="number"
                  step="0.1"
                  value={bounds[key]}
                  onChange={(e) =>
                    setBounds((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  className="mt-1 w-24 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
              </div>
            ))}
            <p className="w-full text-xs text-gray-400">
              Defaults to the Israel bounding box ({DEFAULT_GEO_BOUNDS.minLat}–
              {DEFAULT_GEO_BOUNDS.maxLat}°N, {DEFAULT_GEO_BOUNDS.minLon}–
              {DEFAULT_GEO_BOUNDS.maxLon}°E). Blank/invalid fields fall back to
              the default.
            </p>
          </div>
        )}
      </div>

      {scan.kind === "error" && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Scan failed: {scan.message}
        </div>
      )}

      {del.kind === "done" && (
        <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          Deleted {del.deleted} points.
          {del.perCriterion && (
            <>
              {" "}Breakdown: accuracy={del.perCriterion.accuracy}, speed={del.perCriterion.speed}, place_drift={del.perCriterion.place_drift}, out_of_israel={del.perCriterion.out_of_israel}.
            </>
          )}
        </div>
      )}
      {del.kind === "error" && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Delete failed: {del.message}
        </div>
      )}

      {scan.kind === "scanned" && (
        <div className="space-y-4">
          <div className="grid grid-cols-5 gap-3">
            <StatCard label="Total scanned" value={scan.result.totalScanned} />
            <CheckCard
              label="Accuracy > 100m"
              value={scan.result.badAccuracy.length}
              checked={selected.has("accuracy")}
              onToggle={() => toggleCategory("accuracy")}
            />
            <CheckCard
              label="Implausible speed"
              value={scan.result.badSpeed.length}
              checked={selected.has("speed")}
              onToggle={() => toggleCategory("speed")}
            />
            <CheckCard
              label="Place drift"
              value={scan.result.badPlaceDrift.length}
              checked={selected.has("place_drift")}
              onToggle={() => toggleCategory("place_drift")}
            />
            <CheckCard
              label={geoEnabled ? "Outside bounds" : "Outside bounds (off)"}
              value={scan.result.badOutOfIsrael.length}
              checked={selected.has("out_of_israel")}
              disabled={!geoEnabled}
              onToggle={() => toggleCategory("out_of_israel")}
            />
          </div>

          <div className="flex items-center gap-3 rounded-md border border-gray-200 bg-white p-3">
            <div className="flex-1 text-sm">
              <strong>{idsForSelection(scan.result).length}</strong> unique points selected from this scan (
              {scan.result.uniqueBadIds.length} total flagged across all criteria).
            </div>
            <button
              type="button"
              onClick={runDelete}
              disabled={isPending || idsForSelection(scan.result).length === 0}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-50"
            >
              {del.kind === "deleting" ? "Deleting…" : "Delete selected (from preview)"}
            </button>
          </div>

          {selected.has("accuracy") && (
            <Section title="Accuracy > 100m" points={scan.result.badAccuracy} />
          )}
          {selected.has("speed") && (
            <Section title="Implausible speed" points={scan.result.badSpeed} />
          )}
          {selected.has("place_drift") && (
            <Section title="Place drift" points={scan.result.badPlaceDrift} />
          )}
          {selected.has("out_of_israel") && (
            <Section title="Outside Israel" points={scan.result.badOutOfIsrael} />
          )}
        </div>
      )}
    </div>
  );
}

function humanRange(r: TimeRange): string {
  return TIME_RANGE_OPTIONS.find((o) => o.value === r)?.label ?? r;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value.toLocaleString()}</div>
    </div>
  );
}

function CheckCard({
  label,
  value,
  checked,
  onToggle,
  disabled = false,
}: {
  label: string;
  value: number;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-md border p-3 ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      } ${checked ? "border-admin bg-amber-50" : "border-gray-200 bg-white"}`}
    >
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="mt-1 text-2xl font-semibold text-gray-900">{value.toLocaleString()}</div>
      </div>
    </label>
  );
}

function Section({ title, points }: { title: string; points: BadPoint[] }) {
  if (points.length === 0) return null;
  const shown = points.slice(0, 50);
  return (
    <div className="rounded-md border border-gray-200 bg-white">
      <div className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold">
        {title} <span className="text-gray-500">({points.length} flagged{points.length > 50 ? `, showing first 50` : ""})</span>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Place</th>
              <th className="px-3 py-2">Detail</th>
              <th className="px-3 py-2">Lat/Lon</th>
              <th className="px-3 py-2">ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {shown.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-gray-700">
                  {new Date(p.timestamp).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-gray-600">{p.matched_place ?? "—"}</td>
                <td className="px-3 py-2 text-gray-900">{p.detail}</td>
                <td className="px-3 py-2 font-mono text-gray-500">
                  {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
                </td>
                <td className="px-3 py-2 font-mono text-gray-400">{p.id.slice(0, 8)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
