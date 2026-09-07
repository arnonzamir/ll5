"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import { extractJson, extractText, mcpCall } from "@/lib/api";
import {
  RESET_POLICY,
  normalisePolicy,
  normaliseStats,
  type DeliveryPolicy,
  type DeliveryStats,
} from "./delivery-types";

// DECISION-034 Phase 4 — "What works for you". Reads the learned policy from
// the awareness user model (section `delivery_policy`) and the 14-day outcome
// aggregate from the gateway; the only write is the reset. Each half degrades
// on its own: the page shows an amber line for whichever source is down.

export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };

export interface DeliveryPageData {
  /** null = no section yet (nothing learned); the defaults apply. */
  policy: Loaded<DeliveryPolicy | null>;
  stats: Loaded<DeliveryStats>;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

const STATS_DAYS = 14;
const POLICY_SECTION = "delivery_policy";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readPolicy(): Promise<Loaded<DeliveryPolicy | null>> {
  try {
    const result = await mcpCall("awareness", "read_user_model", { section: POLICY_SECTION });
    if (result.isError) {
      const text = extractText(result).trim();
      console.error("[delivery] read_user_model returned an error:", text);
      return { ok: false, error: text.slice(0, 200) || "awareness MCP returned an error" };
    }
    const parsed = extractJson<{ section?: string | null; content?: unknown } | null>(result);
    if (!parsed || parsed.section == null || parsed.content == null) return { ok: true, data: null };
    return { ok: true, data: normalisePolicy(parsed.content) };
  } catch (err) {
    console.error("[delivery] read_user_model delivery_policy failed:", errMessage(err));
    return { ok: false, error: errMessage(err) };
  }
}

async function readStats(token: string): Promise<Loaded<DeliveryStats>> {
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/delivery-stats?days=${STATS_DAYS}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[delivery] GET /me/delivery-stats failed: ${res.status}`);
      return { ok: false, error: `Gateway ${res.status}` };
    }
    return { ok: true, data: normaliseStats(await res.json(), STATS_DAYS) };
  } catch (err) {
    console.error("[delivery] GET /me/delivery-stats threw:", errMessage(err));
    return { ok: false, error: `Gateway unreachable: ${errMessage(err)}` };
  }
}

export async function fetchDeliveryPage(): Promise<DeliveryPageData> {
  const token = await getToken();
  if (!token) {
    const error = "Not signed in";
    return { policy: { ok: false, error }, stats: { ok: false, error } };
  }
  const [policy, stats] = await Promise.all([readPolicy(), readStats(token)]);
  return { policy, stats };
}

/** Write the empty policy back: version 1, exploration 0.35, no buckets. */
export async function resetDeliveryPolicy(): Promise<ActionResult> {
  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in" };
  try {
    const result = await mcpCall("awareness", "write_user_model", {
      section: POLICY_SECTION,
      content: { ...RESET_POLICY, buckets: {} },
    });
    if (result.isError) {
      const text = extractText(result).trim();
      console.error("[delivery] write_user_model reset refused:", text);
      return { ok: false, error: text.slice(0, 300) || "awareness MCP refused the write" };
    }
    return { ok: true };
  } catch (err) {
    console.error("[delivery] write_user_model reset failed:", errMessage(err));
    return { ok: false, error: errMessage(err) };
  }
}
