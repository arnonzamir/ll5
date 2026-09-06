// Plain types + constants for the connectors page. Kept out of the
// `"use server"` file because Next.js 15 only allows async functions to be
// exported from server-action modules (see data-sources-types.ts).
//
// CATALOG: a copy of the display fields of `CONNECTOR_CATALOG` in
// packages/shared/src/connectors/catalog.ts. The dashboard does not depend on
// @ll5/shared (docker/Dockerfile.dashboard copies only packages/dashboard/),
// so the list is duplicated here. Keep ids, labels, kinds, auth types,
// sensitivity and schedule in sync with the shared catalog.
//
// No scrapers and no portal automation (Arnon, 2026-09-06): phone events
// (`auth_type:'none'`), official APIs (`api_token`) and a licensed aggregator
// (`oauth`) only.

export type ConnectorKind = "event" | "ledger" | "stream";
export type ConnectorAuthType = "none" | "api_token" | "oauth";
export type ConnectorSensitivity = "financial" | "medical" | "civic" | "utility" | "home";
export type ConnectorStatus = "unconfigured" | "ok" | "auth_failed" | "error" | "stale";

export interface ConnectorCatalogEntry {
  id: string;
  label: string;
  kinds: ConnectorKind[];
  auth_type: ConnectorAuthType;
  sensitivity: ConnectorSensitivity;
  default_schedule_minutes: number | null;
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  { id: "cal", label: "Cal (Visa Cal)", kinds: ["event"], auth_type: "none", sensitivity: "financial", default_schedule_minutes: null },
  { id: "max", label: "Max", kinds: ["event"], auth_type: "none", sensitivity: "financial", default_schedule_minutes: null },
  { id: "isracard", label: "Isracard", kinds: ["event"], auth_type: "none", sensitivity: "financial", default_schedule_minutes: null },
  { id: "bank", label: "Bank notifications (Discount, Leumi, OneZero)", kinds: ["event"], auth_type: "none", sensitivity: "financial", default_schedule_minutes: null },
  { id: "paybox", label: "PayBox", kinds: ["event"], auth_type: "none", sensitivity: "financial", default_schedule_minutes: null },
  { id: "clalit", label: "Clalit (HMO)", kinds: ["event"], auth_type: "none", sensitivity: "medical", default_schedule_minutes: null },
  { id: "iec", label: "Israel Electric Corporation", kinds: ["event"], auth_type: "none", sensitivity: "utility", default_schedule_minutes: null },
  { id: "water", label: "Water corporation (Mayanot HaCarmel)", kinds: ["event"], auth_type: "none", sensitivity: "utility", default_schedule_minutes: null },
  { id: "home-assistant", label: "Home Assistant", kinds: ["stream", "ledger"], auth_type: "api_token", sensitivity: "home", default_schedule_minutes: 60 },
  { id: "financy", label: "Financy (licensed open-banking aggregator: the ledger for every bank and card)", kinds: ["ledger"], auth_type: "oauth", sensitivity: "financial", default_schedule_minutes: 360 },
];

/** Picker groups, in display order. */
export type PickerGroup = "cards" | "health" | "utilities" | "home" | "ledger";

export const PICKER_GROUPS: ReadonlyArray<{ id: PickerGroup; label: string }> = [
  { id: "cards", label: "Cards and bank" },
  { id: "health", label: "Health" },
  { id: "utilities", label: "Utilities" },
  { id: "home", label: "Home" },
  { id: "ledger", label: "Ledger" },
];

/** Dashboard-only display fields: which picker group a connector sits in and what it feeds. */
export const CONNECTOR_PICKER: Record<string, { group: PickerGroup; description: string }> = {
  cal: { group: "cards", description: "charges from the Cal app on your phone" },
  max: { group: "cards", description: "charges from the Max app on your phone" },
  isracard: { group: "cards", description: "charges from the Isracard app on your phone" },
  bank: { group: "cards", description: "account notifications from the Discount, Leumi and OneZero apps and SMS" },
  paybox: { group: "cards", description: "payments and requests from the PayBox app on your phone" },
  clalit: { group: "health", description: "appointments and results from the Clalit app on your phone" },
  iec: { group: "utilities", description: "bills and outage notices from the IEC app and SMS" },
  water: { group: "utilities", description: "water corporation SMS (Mayanot HaCarmel)" },
  "home-assistant": { group: "home", description: "house state from Home Assistant" },
  financy: { group: "ledger", description: "the ledger for every bank and card" },
};

/** Alert rules apply to card / bank events, so the rules section shows only when one of these is selected. */
export function isCardOrBank(connectorId: string): boolean {
  return CONNECTOR_PICKER[connectorId]?.group === "cards";
}

/** One-line, per-connector hint shown above the credentials form (where the values come from). */
export const CREDENTIAL_HINTS: Record<string, string> = {
  financy: "The values come from the Financy app, Settings → API (client id, client secret, user id). Only read-only data endpoints are called; refresh and payments never.",
  "home-assistant": "Create a long-lived access token in Home Assistant (your profile → Security). Base URL is the address the connectors service can reach, e.g. https://ha.example.com.",
};

/** One row of the `list_connectors` tool result (contract in docs/design/connectors.md, Section 5). */
export interface ConnectorRow {
  id: string;
  label: string;
  kinds: string[];
  auth_type: string;
  sensitivity: string;
  enabled: boolean;
  status: ConnectorStatus;
  last_success_at: string | null;
  last_error: string | null;
  schedule_minutes: number | null;
  has_credentials: boolean;
}

/** What the page renders: the catalog entry merged with the per-user row (or defaults when the MCP is down). */
export interface ConnectorView extends ConnectorRow {
  auth_type: ConnectorAuthType;
  sensitivity: ConnectorSensitivity;
  default_schedule_minutes: number | null;
}

/** Rules stored under `user_settings.settings.connectors.rules`. */
export interface ConnectorRules {
  amount_threshold: number;
  duplicate_window_minutes: number;
  foreign: boolean;
  unknown_merchant: boolean;
  asleep_at_home: boolean;
  known_merchants: string[];
}

export const DEFAULT_RULES: ConnectorRules = {
  amount_threshold: 500,
  duplicate_window_minutes: 10,
  foreign: true,
  unknown_merchant: true,
  asleep_at_home: true,
  known_merchants: [],
};

export interface ConnectorsPageData {
  connectors: ConnectorView[];
  rules: ConnectorRules;
  /** false when `list_connectors` failed — the page still renders the catalog with a warning. */
  mcpAvailable: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface SyncResult extends ActionResult {
  counts?: Record<string, unknown>;
}

/** Gateway kill-switch key for a connector (read by the gateway's isSourceEnabled). */
export function dataSourceKey(connectorId: string): string {
  return `connector_${connectorId}`;
}

export const AUTH_TYPE_NOTES: Record<ConnectorAuthType, string> = {
  none: "Captured on the phone: enable it under Settings → Connector capture in the app. Nothing to configure here.",
  api_token: "Long-lived API token stored encrypted on the connectors service.",
  oauth: "OAuth client credentials (client id, client secret, user id) stored encrypted on the connectors service; the service mints short-lived access tokens for the scheduled pull.",
};
