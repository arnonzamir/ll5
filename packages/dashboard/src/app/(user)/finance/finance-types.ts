// Plain types + constants + pure accessors for the /finance page. Kept out
// of the "use server" module (Next 15 only allows async exports there).
// Row shapes mirror the connectors MCP results (packages/connectors/src/types.ts,
// tools/index.ts, snapshot.ts); the dashboard does not depend on @ll5/shared.

export type PeriodDays = 7 | 30 | 90;
export const PERIOD_OPTIONS: PeriodDays[] = [7, 30, 90];
export const DEFAULT_PERIOD: PeriodDays = 30;

/** Rows per query_ledger page (the tool's max). */
export const LEDGER_PAGE_SIZE = 100;
/** Pages the summary walks before it reports `partial` (<= 1000 rows). */
export const SUMMARY_MAX_PAGES = 10;

export const FINANCY_ID = "financy";
export const PRIMARY_CURRENCY = "ILS";

export type LedgerKindFilter = "charge" | "refund";

export interface SnapshotBalance {
  type: string | null;
  amount: number;
  currency: string | null;
}

export interface SnapshotAccount {
  id: string;
  providerId: string | null;
  accountType: string | null;
  currency: string | null;
  last4: string | null;
  balances: SnapshotBalance[];
}

export interface SnapshotConnection {
  id: string;
  providerId: string | null;
  status: string | null;
  lastFetchedAt: string | null;
  dataThrough: string | null;
  hasError: boolean;
}

export interface ConnectorSnapshot {
  accounts: SnapshotAccount[];
  connections: SnapshotConnection[];
  data_through: string | null;
  accounts_fetched_at: string | null;
}

/** One row of list_connectors, with the `snapshot` field added 2026-09-06. */
export interface FinanceConnector {
  id: string;
  label: string;
  kinds: string[];
  sensitivity: string;
  enabled: boolean;
  status: string;
  last_success_at: string | null;
  last_error: string | null;
  has_credentials: boolean;
  snapshot: ConnectorSnapshot;
}

/** A decrypted query_ledger row. */
export interface LedgerRow {
  id: string;
  connector_id: string;
  account_ref: string | null;
  external_id: string;
  kind: string;
  occurred_at: string;
  posted_at: string | null;
  amount: number | null;
  currency: string | null;
  merchant_key: string | null;
  payload: Record<string, unknown> | null;
  fetched_at: string;
}

/** A decrypted query_events row. */
export interface EventRow {
  id: string;
  connector_id: string;
  kind: string;
  occurred_at: string;
  received_at: string;
  amount: number | null;
  currency: string | null;
  foreign?: boolean;
  merchant: string | null;
  account_ref: string | null;
  status: string;
  payload: Record<string, unknown> | null;
}

export interface Finding {
  id: string;
  connector_id: string;
  connector_label: string;
  kind: string;
  summary: string;
  opened_at: string;
}

export interface LedgerFilters {
  period: PeriodDays;
  connector_id?: string;
  /** Card / account last 4 digits (matched against `account_ref` after the fetch — the tool has no such filter). */
  account_last4?: string;
  kind?: LedgerKindFilter;
  /** query_ledger `merchant`: case-insensitive substring over the decrypted page. */
  merchant?: string;
}

export interface BarRow {
  label: string;
  /** Net ILS spend (charges minus refunds). */
  total: number;
  count: number;
}

export interface LedgerSummary {
  currency: string;
  charges: number;
  refunds: number;
  count: number;
  /** Net totals for rows not in the primary currency, by currency code. */
  other_currencies: Record<string, number>;
  top_merchants: BarRow[];
  by_category: BarRow[];
  by_account: BarRow[];
  rows_considered: number;
  /** True when the walk stopped at SUMMARY_MAX_PAGES with more rows left. */
  partial: boolean;
}

export type LedgerPageResult =
  | { ok: true; rows: LedgerRow[]; next_cursor: string | null; truncated: boolean; hidden_by_account: number }
  | { ok: false; error: string };

export type LedgerSummaryResult = { ok: true; summary: LedgerSummary } | { ok: false; error: string };

export interface FinanceOverview {
  connectors: FinanceConnector[];
  /** Latest data_through across ledger connectors, YYYY-MM-DD. */
  data_through: string | null;
  events: EventRow[];
  findings: Finding[];
  known_merchants: string[];
  /** false when list_connectors failed — the shell renders with a warning. */
  mcpAvailable: boolean;
  /** Per-call failures worth showing (no secrets, no payloads). */
  errors: string[];
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface SyncResult extends ActionResult {
  counts?: Record<string, unknown>;
}

// ---------- pure accessors over the decrypted payload ----------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The plaintext merchant of a ledger row (stored only inside the encrypted payload). */
export function rowMerchant(row: LedgerRow): string | null {
  const m = row.payload?.merchant;
  return typeof m === "string" && m.trim() ? m.trim() : null;
}

/**
 * `payload.category.main` when the adapter stored the structured category
 * (Financy: `extra.category = { main, sub }`, flattened into the payload), else
 * the flat `payload.category` string, else null.
 */
export function rowCategoryMain(row: LedgerRow): string | null {
  const p = row.payload;
  if (!p) return null;
  const structured = asRecord(p.category) ?? asRecord(asRecord(p.extra)?.category);
  const main = structured?.main;
  if (typeof main === "string" && main.trim()) return main.trim();
  if (typeof p.category === "string" && p.category.trim()) return p.category.trim();
  return null;
}

export function rowMemo(row: LedgerRow): string | null {
  const m = row.payload?.memo;
  return typeof m === "string" && m.trim() ? m.trim() : null;
}

/** Notification title of an event (raw material the gateway keeps in the payload). */
export function eventTitle(ev: EventRow): string | null {
  const t = ev.payload?.title;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}
