"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import { DEFAULTS, type DataSourceConfig, type DataSources } from "./data-sources-types";

export async function fetchDataSources(): Promise<DataSources> {
  const token = await getToken();
  if (!token) return DEFAULTS;

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return DEFAULTS;
    const raw = (await res.json()) as Record<string, unknown>;
    const ds = (raw.data_sources ?? {}) as Record<string, DataSourceConfig>;

    return {
      gps: ds.gps ?? DEFAULTS.gps,
      im_capture: ds.im_capture ?? DEFAULTS.im_capture,
      calendar: ds.calendar ?? DEFAULTS.calendar,
      health: ds.health ?? DEFAULTS.health,
      whatsapp: ds.whatsapp ?? DEFAULTS.whatsapp,
      findhub: ds.findhub ?? DEFAULTS.findhub,
      device_activity: ds.device_activity ?? DEFAULTS.device_activity,
      bluetooth: ds.bluetooth ?? DEFAULTS.bluetooth,
    };
  } catch {
    return DEFAULTS;
  }
}

export async function updateDataSources(sources: DataSources): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data_sources: sources }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Send a device command to sync a data source toggle to the Android app. */
export async function syncDataSourceToDevice(source: string, enabled: boolean): Promise<void> {
  const token = await getToken();
  if (!token) return;

  try {
    await fetch(`${env.GATEWAY_URL}/commands/queue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_type: "update_data_source",
        payload: { source, enabled },
      }),
    });
  } catch {
    // Non-critical — device will sync on next connection
  }
}
