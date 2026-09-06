"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import { mcpCallJsonSafe } from "@/lib/api";
import { requireStepUp } from "@/lib/step-up";
import {
  CONNECTOR_CATALOG,
  DEFAULT_RULES,
  dataSourceKey,
  type ActionResult,
  type ConnectorRow,
  type ConnectorRules,
  type ConnectorView,
  type ConnectorsPageData,
  type SyncResult,
} from "./connectors-types";

// All token handling stays here: the client never sees the bearer token, the
// credentials it submits are forwarded once and only success/failure returns.
//
// /settings/connectors is in the sensitive catalog (lib/sensitive.ts): every
// exported action first calls requireStepUp(), so a direct action call without
// a fresh password confirmation redirects to /verify instead of returning data.

const STEP_UP_NEXT = "/settings/connectors";

const CONNECTORS_REST = env.CONNECTORS_MCP_URL;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readUserSettings(token: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error("[connectors] read user-settings failed:", errMessage(err));
    return {};
  }
}

async function putUserSettings(token: string, patch: Record<string, unknown>): Promise<ActionResult> {
  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `Gateway settings write failed (${res.status})` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Gateway unreachable: ${errMessage(err)}` };
  }
}

/** Call a REST route on the connectors service (same base URL as its /mcp). */
async function connectorsRest(
  token: string,
  method: "PUT" | "POST",
  path: string,
  body: unknown
): Promise<ActionResult> {
  try {
    const res = await fetch(`${CONNECTORS_REST}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Connectors service ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Connectors service unreachable: ${errMessage(err)}` };
  }
}

function parseRules(raw: unknown): ConnectorRules {
  const r = (raw ?? {}) as Partial<Record<keyof ConnectorRules, unknown>>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    amount_threshold: num(r.amount_threshold, DEFAULT_RULES.amount_threshold),
    duplicate_window_minutes: num(r.duplicate_window_minutes, DEFAULT_RULES.duplicate_window_minutes),
    foreign: bool(r.foreign, DEFAULT_RULES.foreign),
    unknown_merchant: bool(r.unknown_merchant, DEFAULT_RULES.unknown_merchant),
    asleep_at_home: bool(r.asleep_at_home, DEFAULT_RULES.asleep_at_home),
    known_merchants: Array.isArray(r.known_merchants)
      ? r.known_merchants.filter((m): m is string => typeof m === "string")
      : [],
  };
}

/**
 * Everything the page needs in one round trip: the catalog merged with the
 * per-user rows from `list_connectors`, the rules, and whether the MCP answered.
 * When the MCP is down the catalog still renders; enabled flags fall back to
 * the gateway kill switch so the picker stays truthful. Label, kinds and
 * auth_type always come from the catalog (source of truth, no scrapers) even
 * if the service still holds an older row.
 */
export async function fetchConnectorsPage(): Promise<ConnectorsPageData> {
  await requireStepUp(STEP_UP_NEXT);
  const token = await getToken();
  const settings = token ? await readUserSettings(token) : {};
  const rules = parseRules((settings.connectors as Record<string, unknown> | undefined)?.rules);
  const dataSources = (settings.data_sources ?? {}) as Record<string, { enabled?: boolean } | undefined>;

  const data = token
    ? await mcpCallJsonSafe<{ connectors: ConnectorRow[] }>("connectors", "list_connectors")
    : null;
  const rows = new Map<string, ConnectorRow>();
  for (const row of data?.connectors ?? []) rows.set(row.id, row);

  const connectors: ConnectorView[] = CONNECTOR_CATALOG.map((entry) => {
    const row = rows.get(entry.id);
    const gatewayEnabled = dataSources[dataSourceKey(entry.id)]?.enabled ?? false;
    return {
      ...entry,
      enabled: row?.enabled ?? gatewayEnabled,
      status: row?.status ?? "unconfigured",
      last_success_at: row?.last_success_at ?? null,
      last_error: row?.last_error ?? null,
      schedule_minutes: row?.schedule_minutes ?? entry.default_schedule_minutes,
      has_credentials: row?.has_credentials ?? false,
    };
  });

  return { connectors, rules, mcpAvailable: data !== null };
}

/**
 * Enable/disable a connector. Writes BOTH the gateway kill switch
 * (`data_sources.connector_<id>.enabled`, read by isSourceEnabled) and the
 * connector row on the connectors service. The gateway write goes first so a
 * down MCP still leaves ingest gated consistently.
 */
export async function setConnectorEnabled(connectorId: string, enabled: boolean): Promise<ActionResult> {
  await requireStepUp(STEP_UP_NEXT);
  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in" };

  const gw = await putUserSettings(token, {
    data_sources: { [dataSourceKey(connectorId)]: { enabled } },
  });
  if (!gw.ok) return gw;

  const svc = await connectorsRest(token, "PUT", `/api/connectors/${encodeURIComponent(connectorId)}`, { enabled });
  if (!svc.ok) {
    return { ok: false, error: `Gateway switch saved, but the connector row was not updated. ${svc.error ?? ""}`.trim() };
  }
  return { ok: true };
}

export async function updateConnectorSchedule(connectorId: string, scheduleMinutes: number): Promise<ActionResult> {
  await requireStepUp(STEP_UP_NEXT);
  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in" };
  if (!Number.isInteger(scheduleMinutes) || scheduleMinutes < 5) {
    return { ok: false, error: "Schedule must be a whole number of minutes (5 or more)" };
  }
  return connectorsRest(token, "PUT", `/api/connectors/${encodeURIComponent(connectorId)}`, {
    schedule_minutes: scheduleMinutes,
  });
}

/**
 * Store credentials for a connector. The secret object is forwarded verbatim
 * to the connectors service and never echoed back; only ok/error returns.
 */
export async function submitConnectorCredentials(
  connectorId: string,
  authType: string,
  secret: Record<string, string>
): Promise<ActionResult> {
  await requireStepUp(STEP_UP_NEXT);
  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in" };

  // Only official-API and aggregator credentials exist; phone-captured
  // connectors (`auth_type:'none'`) have nothing to store (no scrapers).
  const entry = CONNECTOR_CATALOG.find((c) => c.id === connectorId);
  if (!entry) return { ok: false, error: `Unknown connector: ${connectorId}` };
  if (entry.auth_type !== "api_token" && entry.auth_type !== "oauth") {
    return { ok: false, error: `${entry.label} is captured on the phone and takes no credentials` };
  }
  if (authType !== entry.auth_type) {
    return { ok: false, error: `${entry.label} expects ${entry.auth_type} credentials` };
  }

  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(secret)) {
    const trimmed = v.trim();
    if (trimmed) cleaned[k] = trimmed;
  }
  if (Object.keys(cleaned).length === 0) return { ok: false, error: "No credentials entered" };

  return connectorsRest(token, "POST", `/api/connectors/${encodeURIComponent(connectorId)}/credentials`, {
    auth_type: authType,
    secret: cleaned,
  });
}

/** Run one pull now via the `sync_connector` tool. */
export async function syncConnectorNow(connectorId: string): Promise<SyncResult> {
  await requireStepUp(STEP_UP_NEXT);
  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in" };

  const data = await mcpCallJsonSafe<{ ok: boolean; reason?: string; counts?: Record<string, unknown> }>(
    "connectors",
    "sync_connector",
    { connector_id: connectorId }
  );
  if (!data) return { ok: false, error: "Connectors service did not answer" };
  if (!data.ok) return { ok: false, error: data.reason ?? "Sync refused" };
  return { ok: true, counts: data.counts };
}

export async function updateConnectorRules(rules: ConnectorRules): Promise<ActionResult> {
  await requireStepUp(STEP_UP_NEXT);
  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in" };

  const clean = parseRules(rules);
  clean.known_merchants = Array.from(new Set(clean.known_merchants.map((m) => m.trim()).filter(Boolean)));
  return putUserSettings(token, { connectors: { rules: clean } });
}
