"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

// DECISION-034 Section 4 — the activity rail is a view over the gateway's
// GET /me/activity (one entry per handled trigger). The token never leaves the
// server; the client gets entries or an error string, nothing else.

export type ActivityDecision = "ping_now" | "ping_later" | "suppress";

export interface ActivityEntry {
  id: string;
  at: string;
  trigger: { id: string; kind: string; summary: string };
  thought: string | null;
  decision: ActivityDecision | null;
  reason: string | null;
  category: string | null;
  outcome: {
    message_id?: string;
    tray_item_id?: string;
    deferral_ref?: string;
    class?: string;
  } | null;
  cost_usd?: number | null;
}

export type ActivityResult =
  | { ok: true; entries: ActivityEntry[]; next_cursor: string | null }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normaliseEntry(raw: unknown): ActivityEntry | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const at = str(raw.at);
  if (!id || !at) return null;
  const t = isRecord(raw.trigger) ? raw.trigger : {};
  const decision = raw.decision;
  const o = isRecord(raw.outcome) ? raw.outcome : null;
  return {
    id,
    at,
    trigger: {
      id: str(t.id) ?? "",
      kind: str(t.kind) ?? "trigger",
      summary: str(t.summary) ?? "",
    },
    thought: str(raw.thought),
    decision:
      decision === "ping_now" || decision === "ping_later" || decision === "suppress" ? decision : null,
    reason: str(raw.reason),
    category: str(raw.category),
    outcome: o
      ? {
          message_id: str(o.message_id) ?? undefined,
          tray_item_id: str(o.tray_item_id) ?? undefined,
          deferral_ref: str(o.deferral_ref) ?? undefined,
          class: str(o.class) ?? undefined,
        }
      : null,
    cost_usd: typeof raw.cost_usd === "number" && Number.isFinite(raw.cost_usd) ? raw.cost_usd : null,
  };
}

export async function fetchActivity(opts: {
  limit?: number;
  cursor?: string | null;
  since?: string | null;
} = {}): Promise<ActivityResult> {
  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in" };

  const sp = new URLSearchParams();
  sp.set("limit", String(Math.min(Math.max(opts.limit ?? 40, 1), 100)));
  if (opts.cursor) sp.set("cursor", opts.cursor);
  if (opts.since) sp.set("since", opts.since);

  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/activity?${sp.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[activity] GET /me/activity failed: ${res.status}`);
      return { ok: false, error: `Gateway ${res.status}` };
    }
    const data: unknown = await res.json();
    const d = isRecord(data) ? data : {};
    const entries = (Array.isArray(d.entries) ? d.entries : [])
      .map(normaliseEntry)
      .filter((e): e is ActivityEntry => e !== null);
    return { ok: true, entries, next_cursor: str(d.next_cursor) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[activity] GET /me/activity threw:", message);
    return { ok: false, error: `Gateway unreachable: ${message}` };
  }
}
