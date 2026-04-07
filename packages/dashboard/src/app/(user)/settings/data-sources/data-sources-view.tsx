"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, MapPin, MessageSquare, Calendar, Heart, Phone } from "lucide-react";
import {
  fetchDataSources,
  updateDataSources,
  DEFAULTS,
  type DataSources,
} from "./data-sources-server-actions";

const SOURCE_META: Array<{
  key: keyof DataSources;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: "gps", label: "GPS Location Tracking", description: "Phone reports location periodically for context awareness", icon: MapPin },
  { key: "im_capture", label: "IM Notification Capture", description: "Captures incoming messages from phone notification listener", icon: MessageSquare },
  { key: "calendar", label: "Calendar Events", description: "Phone pushes calendar events for schedule awareness", icon: Calendar },
  { key: "health", label: "Health Data", description: "Garmin and other health sources sync sleep, HR, activities", icon: Heart },
  { key: "whatsapp", label: "WhatsApp Messages", description: "Evolution API webhook processes WhatsApp messages", icon: Phone },
];

export function DataSourcesView() {
  const [sources, setSources] = useState<DataSources>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const s = await fetchDataSources();
    setSources(s);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleToggle(key: keyof DataSources, enabled: boolean) {
    const updated = { ...sources, [key]: { ...sources[key], enabled } };
    setSources(updated);

    setSaving(true);
    await updateDataSources(updated);
    setSaving(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Data Sources</h1>
          <p className="text-sm text-gray-500 mt-1">Control which data collection pipelines are active. Disabling stops new collection; existing data is preserved.</p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="space-y-3">
        {SOURCE_META.map(({ key, label, description, icon: Icon }) => (
          <div
            key={key}
            className={`flex items-center gap-4 p-4 rounded-lg border transition-colors ${
              sources[key].enabled ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50"
            }`}
          >
            <Icon className={`h-5 w-5 shrink-0 ${sources[key].enabled ? "text-blue-500" : "text-gray-300"}`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-gray-400 mt-0.5">{description}</div>
            </div>
            <button
              onClick={() => handleToggle(key, !sources[key].enabled)}
              disabled={saving}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                sources[key].enabled ? "bg-blue-500" : "bg-gray-200"
              }`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                sources[key].enabled ? "translate-x-5" : "translate-x-0"
              }`} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
