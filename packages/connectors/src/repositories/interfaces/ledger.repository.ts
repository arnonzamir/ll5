import type { LedgerFilters, LedgerRowInput, LedgerRowRecord, Page } from '../../types.js';
import type { ReconcileRow } from '../../reconcile.js';

/** The batch feed. Upsert on (user, connector, external_id); payloads encrypted at rest. */
export interface LedgerRepository {
  upsertMany(connectorId: string, rows: LedgerRowInput[]): Promise<{ inserted: number; updated: number }>;
  query(filters: LedgerFilters): Promise<Page<LedgerRowRecord>>;
  /** Rows of one connector in [sinceIso, untilIso], in the shape the reconciler takes. */
  forReconcile(connectorId: string, sinceIso: string, untilIso: string): Promise<ReconcileRow[]>;
  count(connectorId: string): Promise<number>;
  /** Retention: delete rows older than `months`. Returns the count. */
  deleteOlderThan(connectorId: string, months: number): Promise<number>;
  /** connector_id → newest fetched_at ISO, for feed ages. */
  newestFetchedAt(): Promise<Record<string, string>>;
}
