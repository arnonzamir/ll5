"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Download, Loader2, CheckCircle2, Database } from "lucide-react";

export function ExportView() {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleExport() {
    setStatus(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/export");
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          setStatus({ type: "error", message: `Export failed (${res.status}): ${body}` });
          return;
        }

        // Trigger download
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = res.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ?? `ll5-export-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setStatus({ type: "success", message: "Export downloaded" });
      } catch (err) {
        setStatus({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-2">Export Data</h1>
      <p className="text-sm text-gray-500 mb-6">Download a full backup of all your data</p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4" /> Full Data Export
          </CardTitle>
          <CardDescription className="text-xs">
            Exports all your data as a single JSON file: knowledge (facts, people, places), GTD (actions, projects, horizons, inbox), calendar events, health data, chat messages, journal entries, media records, and settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={handleExport} disabled={isPending}>
            {isPending ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Exporting...</>
            ) : (
              <><Download className="h-4 w-4 mr-2" /> Download Export</>
            )}
          </Button>

          {status && (
            <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md ${
              status.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
            }`}>
              {status.type === "success" && <CheckCircle2 className="h-4 w-4" />}
              {status.message}
            </div>
          )}

          <div className="text-xs text-gray-400 space-y-1">
            <p>The export includes data from all connected services:</p>
            <ul className="list-disc list-inside">
              <li>Personal knowledge: facts, people, places, profile</li>
              <li>GTD: actions, projects, horizons, inbox</li>
              <li>Calendar events and ticklers</li>
              <li>Health: sleep, heart rate, daily stats, activities</li>
              <li>Awareness: locations, messages, entity statuses</li>
              <li>Agent journal and user model</li>
              <li>Chat messages (last 5,000)</li>
              <li>Media records and settings</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
