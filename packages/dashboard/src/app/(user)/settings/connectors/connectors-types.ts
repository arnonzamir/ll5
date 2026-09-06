// Plain types + constants for the connectors page. Kept out of the
// `"use server"` file because Next.js 15 only allows async functions to be
// exported from server-action modules (see data-sources-types.ts).
//
// CATALOG: a copy of the display fields of `CONNECTOR_CATALOG` in
// packages/shared/src/connectors/catalog.ts. The dashboard does not depend on
// @ll5/shared (docker/Dockerfile.dashboard copies only packages/dashboard/),
// so the list is duplicated here. Keep the ids in sync with the shared
// catalog when adding a connector.

export type ConnectorKind = "event" | "ledger" | "stream";
export type ConnectorAuthType = "none" | "scraper_credentials" | "vault_browser_login" | "api_token" | "oauth";
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
  { id: "cal", label: "Cal (Visa Cal)", kinds: ["event", "ledger"], auth_type: "scraper_credentials", sensitivity: "financial", default_schedule_minutes: 720 },
  { id: "max", label: "Max", kinds: ["event", "ledger"], auth_type: "scraper_credentials", sensitivity: "financial", default_schedule_minutes: 720 },
  { id: "isracard", label: "Isracard", kinds: ["event", "ledger"], auth_type: "scraper_credentials", sensitivity: "financial", default_schedule_minutes: 720 },
  { id: "bank", label: "Bank account", kinds: ["event", "ledger"], auth_type: "scraper_credentials", sensitivity: "financial", default_schedule_minutes: 1440 },
  { id: "clalit", label: "Clalit (HMO)", kinds: ["event", "ledger"], auth_type: "vault_browser_login", sensitivity: "medical", default_schedule_minutes: null },
  { id: "iec", label: "Israel Electric Corporation", kinds: ["event", "ledger"], auth_type: "api_token", sensitivity: "utility", default_schedule_minutes: 60 },
  { id: "municipality", label: "Municipality (city4u)", kinds: ["ledger"], auth_type: "vault_browser_login", sensitivity: "civic", default_schedule_minutes: null },
  { id: "home-assistant", label: "Home Assistant", kinds: ["stream", "ledger"], auth_type: "api_token", sensitivity: "home", default_schedule_minutes: 60 },
  { id: "financy", label: "Financy (open-banking aggregator: all banks and cards)", kinds: ["ledger"], auth_type: "oauth", sensitivity: "financial", default_schedule_minutes: 360 },
];

/** One-line, per-connector hint shown above the credentials form (where the values come from). */
export const CREDENTIAL_HINTS: Record<string, string> = {
  financy: "The values come from the Financy app, Settings → API (client id, client secret, user id). Only read-only data endpoints are called; refresh and payments never.",
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
  none: "No authentication: events arrive from the phone or a webhook only.",
  scraper_credentials: "Portal login stored encrypted on the connectors service; used only by the scheduled pull.",
  vault_browser_login: "Authenticated through the vault browser login (vault-login skill). No credentials are stored here.",
  api_token: "Long-lived API token stored encrypted on the connectors service.",
  oauth: "OAuth client credentials (client id, client secret, user id) stored encrypted on the connectors service; the service mints short-lived access tokens for the scheduled pull.",
};
