"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import { mcpCallJson } from "@/lib/api";
import { requireStepUp } from "@/lib/step-up";
import { DEFAULT_RULES, type ConnectorRules } from "../settings/connectors/connectors-types";
import { summarizeLedgerRows } from "./finance-summary";
import {
  FINANCY_ID,
  LEDGER_PAGE_SIZE,
  SUMMARY_MAX_PAGES,
  type ActionResult,
  type EventRow,
  type FinanceConnector,
  type FinanceOverview,
  type Finding,
  type LedgerFilters,
  type LedgerPageResult,
  type LedgerRow,
  type LedgerSummaryResult,
  type SyncResult,
} from "./finance-types";

// /finance is in the sensitive catalog (lib/sensitive.ts): every exported
// action calls requireStepUp() first, so nothing here answers without a fresh
// password confirmation even when called directly. All data comes from the
// connectors MCP with the user's own token; the token never reaches the client.
// Only two writes exist on this page: known_merchants (user settings) and
// resolve_finding / sync_connector on the MCP.

const STEP_UP_NEXT = "/finance";
const DAY_MS = 86_400_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Like mcpCallJsonSafe but keeps the failure reason (already logged there) for the page banner. */
async function tryTool<T>(tool: string, args: Record<string, unknown>, errors: string[]): Promise<T | null> {
  try {
    return await mcpCallJson<T>("connectors", tool, args);
  } catch (err) {
    const msg = errMessage(err);
    console.error(`[finance] connectors/${tool} failed:`, msg);
    errors.push(`${tool}: ${msg.slice(0, 160)}`);
    return null;
  }
}

async function readUserSettings(token: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error("[finance] read user-settings failed:", errMessage(err));
    return {};
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

function periodRange(period: number): { since: string; until: string } {
  const now = Date.now();
  return { since: new Date(now - period * DAY_MS).toISOString(), until: new Date(now).toISOString() };
}

function ledgerArgs(filters: LedgerFilters, cursor?: string | null): Record<string, unknown> {
  const { since, until } = periodRange(filters.period);
  const args: Record<string, unknown> = { since, until, limit: LEDGER_PAGE_SIZE };
  if (filters.connector_id) args.connector_id = filters.connector_id;
  if (filters.kind) args.kind = filters.kind;
  const merchant = filters.merchant?.trim();
  if (merchant) args.merchant = merchant.slice(0, 120);
  if (cursor) args.cursor = cursor;
  return args;
}

function last4Filter(rows: LedgerRow[], last4?: string): { rows: LedgerRow[]; hidden: number } {
  const digits = (last4 ?? "").replace(/\D+/g, "").slice(-4);
  if (!digits) return { rows, hidden: 0 };
  const kept = rows.filter((r) => (r.account_ref ?? "").replace(/\D+/g, "").endsWith(digits));
  return { rows: kept, hidden: rows.length - kept.length };
}

interface LedgerToolResult {
  rows?: LedgerRow[];
  truncated?: boolean;
  next_cursor?: string;
}

/**
 * Everything above the ledger in one round trip: connectors (with the config
 * snapshot), the last 50 events, open findings from the weekly digest and the
 * known-merchant list. Each call degrades on its own; `mcpAvailable` follows
 * list_connectors so the shell still renders when the service is down.
 */
export async function fetchFinanceOverview(): Promise<FinanceOverview> {
  await requireStepUp(STEP_UP_NEXT);
  const token = await getToken();
  const errors: string[] = [];

  const [connectorsRes, eventsRes, digestRes, settings] = await Promise.all([
    tryTool<{ connectors: FinanceConnector[] }>("list_connectors", {}, errors),
    tryTool<{ events: EventRow[] }>("query_events", { limit: 50 }, errors),
    tryTool<{ connectors: Array<{ id: string; label: string; open_findings?: Finding[] }> }>(
      "get_connector_digest",
      { period: "week" },
      errors,
    ),
    token ? readUserSettings(token) : Promise.resolve<Record<string, unknown>>({}),
  ]);

  const connectors = (connectorsRes?.connectors ?? [])
    .filter((c) => c.sensitivity === "financial")
    .map((c) => ({
      ...c,
      snapshot: c.snapshot ?? { accounts: [], connections: [], data_through: null, accounts_fetched_at: null },
    }));

  const data_through = connectors.reduce<string | null>((m, c) => {
    const d = c.snapshot.data_through;
    return d && (!m || d > m) ? d : m;
  }, null);

  const findings: Finding[] = [];
  for (const c of digestRes?.connectors ?? []) {
    for (const f of c.open_findings ?? []) {
      findings.push({ ...f, connector_id: c.id, connector_label: c.label });
    }
  }
  findings.sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));

  const rules = parseRules((settings.connectors as Record<string, unknown> | undefined)?.rules);

  return {
    connectors,
    data_through,
    events: eventsRes?.events ?? [],
    findings,
    known_merchants: rules.known_merchants,
    mcpAvailable: connectorsRes !== null,
    errors,
  };
}

/** One page of query_ledger for the filters (newest first); `cursor` continues a truncated page. */
export async function fetchLedgerPage(filters: LedgerFilters, cursor?: string | null): Promise<LedgerPageResult> {
  await requireStepUp(STEP_UP_NEXT);
  const errors: string[] = [];
  const res = await tryTool<LedgerToolResult>("query_ledger", ledgerArgs(filters, cursor), errors);
  if (!res) return { ok: false, error: errors[0] ?? "Connectors service did not answer" };
  const { rows, hidden } = last4Filter(res.rows ?? [], filters.account_last4);
  return {
    ok: true,
    rows,
    next_cursor: res.truncated && res.next_cursor ? res.next_cursor : null,
    truncated: res.truncated === true,
    hidden_by_account: hidden,
  };
}

/**
 * Period summary computed server-side: walks query_ledger pages for the same
 * filters (up to SUMMARY_MAX_PAGES) and aggregates the decrypted rows.
 */
export async function fetchLedgerSummary(filters: LedgerFilters): Promise<LedgerSummaryResult> {
  await requireStepUp(STEP_UP_NEXT);
  const errors: string[] = [];
  const all: LedgerRow[] = [];
  let cursor: string | null = null;
  let partial = false;
  for (let page = 0; page < SUMMARY_MAX_PAGES; page++) {
    const res: LedgerToolResult | null = await tryTool<LedgerToolResult>("query_ledger", ledgerArgs(filters, cursor), errors);
    if (!res) return { ok: false, error: errors[0] ?? "Connectors service did not answer" };
    all.push(...(res.rows ?? []));
    if (res.truncated && res.next_cursor) {
      cursor = res.next_cursor;
      if (page === SUMMARY_MAX_PAGES - 1) partial = true;
    } else {
      break;
    }
  }
  const { rows } = last4Filter(all, filters.account_last4);
  return { ok: true, summary: summarizeLedgerRows(rows, partial) };
}

/**
 * "Mark merchant as known": appends to
 * user_settings.settings.connectors.rules.known_merchants (the list the
 * gateway's unknown-merchant rule consults), same PUT shape as the connectors
 * settings page. Deduplicated, trimmed, capped at 120 chars like the tool schema.
 */
export async function markMerchantKnown(merchant: string): Promise<ActionResult> {
  await requireStepUp(STEP_UP_NEXT);
  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in" };
  const name = merchant.trim().slice(0, 120);
  if (!name) return { ok: false, error: "No merchant name on this row" };

  const settings = await readUserSettings(token);
  const rules = parseRules((settings.connectors as Record<string, unknown> | undefined)?.rules);
  if (rules.known_merchants.some((m) => m.toLowerCase() === name.toLowerCase())) return { ok: true };
  rules.known_merchants = [...rules.known_merchants, name];

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ connectors: { rules } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `Gateway settings write failed (${res.status})` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Gateway unreachable: ${errMessage(err)}` };
  }
}

/** Resolve one open finding (the only write on findings). */
export async function resolveFindingAction(id: string, note?: string): Promise<ActionResult> {
  await requireStepUp(STEP_UP_NEXT);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "Invalid finding id" };
  const errors: string[] = [];
  const args: Record<string, unknown> = { id };
  if (note?.trim()) args.note = note.trim().slice(0, 300);
  const res = await tryTool<{ ok?: boolean; error?: string }>("resolve_finding", args, errors);
  if (!res) return { ok: false, error: errors[0] ?? "Connectors service did not answer" };
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
}

/** "Sync Financy now" — one ledger pull via sync_connector (rate-limited by the service). */
export async function syncFinancyNow(): Promise<SyncResult> {
  await requireStepUp(STEP_UP_NEXT);
  const errors: string[] = [];
  const res = await tryTool<{ ok: boolean; reason?: string; counts?: Record<string, unknown> }>(
    "sync_connector",
    { connector_id: FINANCY_ID },
    errors,
  );
  if (!res) return { ok: false, error: errors[0] ?? "Connectors service did not answer" };
  if (!res.ok) return { ok: false, error: res.reason ?? "Sync refused" };
  return { ok: true, counts: res.counts };
}
