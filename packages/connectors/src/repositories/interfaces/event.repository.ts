import type { ConnectorEventAck, ConnectorEventInput, ConnectorEventRecord } from '@ll5/shared';
import type { EventFilters, Page } from '../../types.js';
import type { ReconcileEvent } from '../../reconcile.js';

export interface ExpiredEvent {
  id: string;
  connector_id: string;
  kind: string;
  occurred_at: string;
}

/** The near-real-time feed. Payloads are encrypted on write and decrypted only on read. */
export interface EventRepository {
  /** Idempotent on (user, dedupe_key): a repeat returns the existing id with created:false. */
  insert(input: ConnectorEventInput, merchantKey: string | null): Promise<ConnectorEventAck>;
  query(filters: EventFilters): Promise<Page<ConnectorEventRecord>>;
  /** Open events of one connector since `sinceIso`, in the shape the reconciler takes. */
  openForReconcile(connectorId: string, sinceIso: string): Promise<ReconcileEvent[]>;
  markMatched(pairs: Array<{ event_id: string; row_id: string }>): Promise<number>;
  /** Open events older than `hours` → status 'expired'. Returns what was expired. */
  expireOpenOlderThan(connectorId: string, hours: number): Promise<ExpiredEvent[]>;
  /** Retention: drop the encrypted payload of events older than `days`. Returns the count. */
  nullPayloadsOlderThan(days: number): Promise<number>;
  /** connector_id → newest received_at ISO, for feed ages. */
  newestReceivedAt(): Promise<Record<string, string>>;
}
