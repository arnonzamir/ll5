"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

export interface MediaItem {
  id: string;
  url: string;
  mime_type: string;
  filename: string;
  description?: string;
  source: string;
  media_type?: string;
  duration_seconds?: number;
  tags?: string[];
  size_bytes?: number;
  created_at: string;
}

export interface MediaLink {
  entity_type: string;
  entity_id: string;
  linked_at: string;
}

async function gatewayFetch(path: string): Promise<Response> {
  const token = await getToken();
  if (!token) throw new Error("Not authenticated");
  return fetch(`${env.GATEWAY_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

export async function fetchMedia(params?: {
  query?: string;
  source?: string;
  media_type?: string;
  limit?: number;
  offset?: number;
}): Promise<{ media: MediaItem[]; total: number }> {
  try {
    const searchParams = new URLSearchParams();
    if (params?.query) searchParams.set("query", params.query);
    if (params?.source) searchParams.set("source", params.source);
    if (params?.media_type) searchParams.set("media_type", params.media_type);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));

    const qs = searchParams.toString();
    const res = await gatewayFetch(`/media${qs ? `?${qs}` : ""}`);
    if (!res.ok) return { media: [], total: 0 };
    return (await res.json()) as { media: MediaItem[]; total: number };
  } catch (err) {
    console.error(
      "[media] fetchMedia failed:",
      err instanceof Error ? err.message : String(err)
    );
    return { media: [], total: 0 };
  }
}

export async function fetchMediaLinks(
  mediaId: string
): Promise<{ links: MediaLink[] }> {
  try {
    const res = await gatewayFetch(`/media/${mediaId}/links`);
    if (!res.ok) return { links: [] };
    return (await res.json()) as { links: MediaLink[] };
  } catch (err) {
    console.error(
      "[media] fetchMediaLinks failed:",
      err instanceof Error ? err.message : String(err)
    );
    return { links: [] };
  }
}
