/**
 * Event envelope — the contract between the gateway (which parses phone
 * notifications / webhook events) and the connectors MCP (which stores them):
 * `POST /api/events` on the connectors service, service-token auth, body =
 * ConnectorEventInput, response = ConnectorEventAck. The gateway never writes
 * the connectors' tables directly (docs/design/connectors.md, Section 3).
 */
export type ConnectorEventKind =
  | 'charge'
  | 'refund'
  | 'bill'
  | 'appointment'
  | 'notice'
  | 'state_change'
  | 'otp'
  | 'unknown';

export interface ConnectorEventInput {
  connector_id: string;
  kind: ConnectorEventKind;
  /** ISO-8601; the source's own time when known, else receive time. */
  occurred_at: string;
  amount?: number | null;
  /** ISO-4217, e.g. 'ILS'. */
  currency?: string | null;
  foreign?: boolean;
  /** Plaintext merchant as parsed; stored only inside the encrypted payload. */
  merchant?: string | null;
  /** Masked account reference, e.g. card last 4. */
  account_ref?: string | null;
  /** Stable per source event: e.g. sha256(connector_id|package|post_time|title|text). */
  dedupe_key: string;
  /** Raw material: package, title, text, big_text, sender, post_time, anything source-specific. */
  payload: Record<string, unknown>;
  /** Rule ids that fired in the gateway, if any (informational; the gateway already acted). */
  rule_hits?: string[];
}

export interface ConnectorEventAck {
  id: string;
  /** false when dedupe_key already existed. */
  created: boolean;
}

/** Normalized, decrypted row as returned by query_events. */
export interface ConnectorEventRecord extends Omit<ConnectorEventInput, 'payload'> {
  id: string;
  received_at: string;
  status: 'open' | 'matched' | 'expired';
  matched_row_id: string | null;
  payload: Record<string, unknown> | null;
}
