"use client";

import { useState, useTransition } from "react";
import {
  scanBadGpsPoints,
  deleteGpsPoints,
  type BadPoint,
  type GpsScanResult,
} from "./gps-cleanup-server-actions";

type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "error"; message: string }
  | { kind: "scanned"; result: GpsScanResult; scannedAt: string };

type DeleteState =
  | { kind: "idle" }
  | { kind: "deleting" }
  | { kind: "error"; message: string }
  | { kind: "done"; deleted: number };

export function GpsCleanupView() {
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [del, setDel] = useState<DeleteState>({ kind: "idle" });
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<"accuracy" | "speed" | "place_drift">>(
    new Set(["accuracy", "speed", "place_drift"]),
  );

  const runScan = () => {
    setScan({ kind: "scanning" });
    setDel({ kind: "idle" });
    startTransition(async () => {
      const res = await scanBadGpsPoints();
      if (!res.ok) {
        setScan({ kind: "error", message: res.error });
      } else {
        setScan({ kind: "scanned", result: res.result, scannedAt: new Date().toISOString() });
      }
    });
  };

  const idsForSelection = (result: GpsScanResult): string[] => {
    const ids = new Set<string>();
    if (selected.has("accuracy")) result.badAccuracy.forEach((p) => ids.add(p.id));
    if (selected.has("speed")) result.badSpeed.forEach((p) => ids.add(p.id));
    if (selected.has("place_drift")) result.badPlaceDrift.forEach((p) => ids.add(p.id));
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
        // Re-scan so the user sees the post-delete state
        const after = await scanBadGpsPoints();
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

  const toggleCategory = (cat: "accuracy" | "speed" | "place_drift") => {
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
          Scans <code className="rounded bg-amber-100 px-1">ll5_awareness_locations</code> for
          points that <em>would have been rejected</em> by the gateway filters, had the bugs
          fixed on 2026-04-23 been working. Three criteria:
        </p>
        <ul className="ml-5 mt-2 list-disc space-y-0.5">
          <li>
            <strong>Accuracy</strong> — accuracy field &gt; 100 m (the broken{" "}
            <code>item.accuracy</code>/<code>accuracy_m</code> check never fired)
          </li>
          <li>
            <strong>Implausible speed</strong> — &gt; 150 km/h between consecutive points within
            10 min (broken haversine call)
          </li>
          <li>
            <strong>Place drift</strong> — previous point at a known place, current point &gt;500 m
            away within 5 min (same broken filter)
          </li>
        </ul>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={runScan}
          disabled={isPending}
          className="rounded-md bg-admin px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-admin-600 disabled:opacity-50"
        >
          {scan.kind === "scanning" ? "Scanning…" : "Scan"}
        </button>
        {scan.kind === "scanned" && (
          <span className="text-xs text-gray-500">
            Last scan {new Date(scan.scannedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {scan.kind === "error" && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Scan failed: {scan.message}
        </div>
      )}

      {scan.kind === "scanned" && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
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
          </div>

          <div className="flex items-center gap-3 rounded-md border border-gray-200 bg-white p-3">
            <div className="flex-1 text-sm">
              <strong>{idsForSelection(scan.result).length}</strong> unique points selected for
              deletion (
              {scan.result.uniqueBadIds.length} total flagged across all criteria).
            </div>
            <button
              type="button"
              onClick={runDelete}
              disabled={isPending || idsForSelection(scan.result).length === 0}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-50"
            >
              {del.kind === "deleting" ? "Deleting…" : "Delete selected"}
            </button>
          </div>

          {del.kind === "error" && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              Delete failed: {del.message}
            </div>
          )}
          {del.kind === "done" && (
            <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">
              Deleted {del.deleted} points. Table below re-scanned.
            </div>
          )}

          {selected.has("accuracy") && (
            <Section title="Accuracy > 100m" points={scan.result.badAccuracy} />
          )}
          {selected.has("speed") && (
            <Section title="Implausible speed" points={scan.result.badSpeed} />
          )}
          {selected.has("place_drift") && (
            <Section title="Place drift" points={scan.result.badPlaceDrift} />
          )}
        </div>
      )}
    </div>
  );
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
}: {
  label: string;
  value: number;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 ${
        checked ? "border-admin bg-amber-50" : "border-gray-200 bg-white"
      }`}
    >
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
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
