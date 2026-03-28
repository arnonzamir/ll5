"use server";

import { mcpCall, mcpCallList } from "@/lib/api";

export interface Place {
  id: string;
  name: string;
  type?: string;
  address?: string | null;
  geo?: { lat: number; lon: number } | null;
  tags?: string[];
}

export async function fetchPlaces(): Promise<Place[]> {
  return mcpCallList<Place>("knowledge", "list_places");
}

export async function upsertPlace(
  data: Omit<Place, "id" | "geo"> & { id?: string; lat?: number; lon?: number }
): Promise<void> {
  await mcpCall("knowledge", "upsert_place", data as Record<string, unknown>);
}

export async function deletePlace(id: string): Promise<void> {
  await mcpCall("knowledge", "delete_place", { id });
}
