/**
 * The public `snapshot` of a connector row's `config` for list_connectors:
 * an allow-list projection of what a ledger adapter recorded about accounts
 * and connection freshness (Financy writes config.accounts / connections /
 * data_through / accounts_fetched_at). Pure. Everything not on the allow-list
 * is dropped, so credentials, cursors, retention settings or owner info can
 * never leak through this field even if a future adapter stores more.
 */

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
  /** Latest day of data the aggregator holds across connections, YYYY-MM-DD. */
  data_through: string | null;
  /** When the accounts list was last read, ISO. */
  accounts_fetched_at: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function balance(v: unknown): SnapshotBalance | null {
  const b = rec(v);
  if (!b || typeof b.amount !== 'number' || !Number.isFinite(b.amount)) return null;
  return { type: str(b.type), amount: b.amount, currency: str(b.currency) };
}

function account(v: unknown): SnapshotAccount | null {
  const a = rec(v);
  const id = a ? str(a.id) : null;
  if (!a || !id) return null;
  const balances = Array.isArray(a.balances) ? a.balances.map(balance).filter((x): x is SnapshotBalance => x !== null) : [];
  return { id, providerId: str(a.providerId), accountType: str(a.accountType), currency: str(a.currency), last4: str(a.last4), balances };
}

function connection(v: unknown): SnapshotConnection | null {
  const c = rec(v);
  const id = c ? str(c.id) : null;
  if (!c || !id) return null;
  return {
    id,
    providerId: str(c.providerId),
    status: str(c.status),
    lastFetchedAt: str(c.lastFetchedAt),
    dataThrough: str(c.dataThrough),
    hasError: c.hasError === true,
  };
}

export function connectorSnapshot(config: unknown): ConnectorSnapshot {
  const cfg = rec(config) ?? {};
  return {
    accounts: Array.isArray(cfg.accounts) ? cfg.accounts.map(account).filter((x): x is SnapshotAccount => x !== null) : [],
    connections: Array.isArray(cfg.connections) ? cfg.connections.map(connection).filter((x): x is SnapshotConnection => x !== null) : [],
    data_through: str(cfg.data_through),
    accounts_fetched_at: str(cfg.accounts_fetched_at),
  };
}
