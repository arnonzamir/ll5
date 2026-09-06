/**
 * Domain records for the connectors MCP. The event envelope
 * (ConnectorEventInput / ConnectorEventRecord) comes from @ll5/shared and is not
 * redefined here.
 */
import type { ConnectorAuthType, ConnectorEventKind } from '@ll5/shared';

export type ConnectorStatus = 'unconfigured' | 'ok' | 'auth_failed' | 'error' | 'stale';

export interface ConnectorRow {
  connector_id: string;
  enabled: boolean;
  status: ConnectorStatus;
  schedule_minutes: number | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  cursor: unknown;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ConnectorUpsert {
  enabled?: boolean;
  schedule_minutes?: number | null;
  config?: Record<string, unknown>;
}

export interface ConnectorSyncOutcome {
  ok: boolean;
  status: ConnectorStatus;
  error?: string | null;
  cursor?: unknown;
}

export interface CredentialRecord {
  connector_id: string;
  auth_type: ConnectorAuthType | string;
  secret: Record<string, unknown>;
  updated_at: string;
}

export type LedgerRowKind = Exclude<ConnectorEventKind, 'otp' | 'unknown'>;

/** One ledger row as an adapter or the ingest tool hands it in (plaintext). */
export interface LedgerRowInput {
  external_id: string;
  kind: LedgerRowKind;
  occurred_at: string;
  posted_at?: string | null;
  amount?: number | null;
  currency?: string | null;
  merchant?: string | null;
  memo?: string | null;
  account_ref?: string | null;
  category?: string | null;
  installments?: { number: number; total: number } | null;
  /** Source-specific JSON, stored inside the encrypted payload. */
  extra?: Record<string, unknown> | null;
}

/** A decrypted ledger row as returned by query_ledger. */
export interface LedgerRowRecord {
  id: string;
  connector_id: string;
  account_ref: string | null;
  external_id: string;
  kind: LedgerRowKind | string;
  occurred_at: string;
  posted_at: string | null;
  amount: number | null;
  currency: string | null;
  merchant_key: string | null;
  payload: Record<string, unknown> | null;
  fetched_at: string;
}

export type FindingKind = 'unmatched_event' | 'missing_event' | 'stale_feed' | 'auth_failed' | 'rule_hit';
export type FindingDelivery = 'immediate' | 'digest' | 'none';

export interface FindingRecord {
  id: string;
  connector_id: string;
  kind: FindingKind | string;
  summary: string;
  ref_id: string | null;
  opened_at: string;
  resolved_at: string | null;
  resolution: string | null;
  delivered: FindingDelivery | string;
}

export interface FindingInput {
  connector_id: string;
  kind: FindingKind;
  summary: string;
  ref_id?: string | null;
  delivered?: FindingDelivery;
}

export interface EventFilters {
  connector_id?: string;
  since?: string;
  until?: string;
  kind?: string;
  min_amount?: number;
  status?: string;
  limit: number;
  offset: number;
}

export interface LedgerFilters {
  connector_id?: string;
  since?: string;
  until?: string;
  kind?: string;
  min_amount?: number;
  limit: number;
  offset: number;
}

export interface Page<T> {
  items: T[];
  /** The source holds more rows beyond `items`. */
  hasMore: boolean;
}
