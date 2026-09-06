import type { ConnectorRow, ConnectorStatus, ConnectorSyncOutcome, ConnectorUpsert } from '../../types.js';

/** Per-user connector state. Every method is scoped to the request's user. */
export interface ConnectorRepository {
  list(): Promise<ConnectorRow[]>;
  get(connectorId: string): Promise<ConnectorRow | null>;
  /** Create on first call, patch afterwards. Returns the resulting row. */
  upsert(connectorId: string, patch: ConnectorUpsert): Promise<ConnectorRow>;
  /** Record a pull's outcome: status, last_success_at / last_error, failure streak, cursor. */
  recordSync(connectorId: string, outcome: ConnectorSyncOutcome): Promise<void>;
  setStatus(connectorId: string, status: ConnectorStatus): Promise<void>;
}
