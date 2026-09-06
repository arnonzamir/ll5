/**
 * In-memory Repositories fake for behaviour tests (DECISION-029: no
 * call-assertions on mocks; the fake keeps real state and the tests read it).
 */
import type { Repositories } from '../repositories/postgres/index.js';
import type { ConnectorRow, FindingInput, FindingRecord, LedgerRowInput } from '../types.js';
import type { ReconcileEvent } from '../reconcile.js';

export interface MemLedgerRow extends LedgerRowInput {
  id: string;
  connector_id: string;
}

export interface MemEvent extends ReconcileEvent {
  connector_id: string;
  status: 'open' | 'matched' | 'expired';
  matched_row_id: string | null;
}

export function memRepos() {
  const connectors = new Map<string, ConnectorRow>();
  const creds = new Map<string, Record<string, unknown>>();
  const ledger: MemLedgerRow[] = [];
  const events: MemEvent[] = [];
  const findings: FindingRecord[] = [];
  const row = (id: string, p: Partial<ConnectorRow> = {}): ConnectorRow => ({
    connector_id: id, enabled: false, status: 'unconfigured', schedule_minutes: null, last_success_at: null,
    last_error_at: null, last_error: null, consecutive_failures: 0, cursor: null, config: {}, created_at: '', updated_at: '', ...p,
  });
  /** Wall clock the fake stamps on last_success_at (tests move it). */
  const clock = { nowIso: '2026-09-06T10:00:00.000Z' };

  const repos: Repositories = {
    connectors: {
      list: async () => [...connectors.values()],
      get: async (id) => connectors.get(id) ?? null,
      upsert: async (id, patch) => {
        const prev = connectors.get(id) ?? row(id);
        const r: ConnectorRow = {
          ...prev,
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.schedule_minutes !== undefined ? { schedule_minutes: patch.schedule_minutes } : {}),
          config: patch.config ?? prev.config,
        };
        connectors.set(id, r);
        return r;
      },
      recordSync: async (id, o) => {
        const r = connectors.get(id) ?? row(id);
        connectors.set(id, o.ok
          ? { ...r, status: o.status, last_success_at: clock.nowIso, last_error: null, consecutive_failures: 0, cursor: o.cursor ?? r.cursor }
          : { ...r, status: o.status, last_error: o.error ?? null, consecutive_failures: r.consecutive_failures + 1 });
      },
      setStatus: async (id, status) => { connectors.set(id, { ...(connectors.get(id) ?? row(id)), status }); },
    },
    credentials: {
      get: async (id) => (creds.has(id) ? { connector_id: id, auth_type: 'api_token', secret: creds.get(id)!, updated_at: '' } : null),
      put: async (id, _t, secret) => { creds.set(id, secret); },
      connectorIdsWithCredentials: async () => new Set(creds.keys()),
    },
    events: {
      insert: async () => ({ id: 'e', created: true }),
      query: async () => ({ items: [], hasMore: false }),
      openForReconcile: async (sinceIso, connectorId) =>
        events
          .filter((e) => e.status === 'open' && e.occurred_at >= sinceIso && (!connectorId || e.connector_id === connectorId))
          .map(({ id, amount, merchant_key, account_ref, occurred_at }) => ({ id, amount, merchant_key, account_ref, occurred_at })),
      markMatched: async (pairs) => {
        let n = 0;
        for (const p of pairs) {
          const ev = events.find((e) => e.id === p.event_id && e.status === 'open');
          if (ev) { ev.status = 'matched'; ev.matched_row_id = p.row_id; n++; }
        }
        return n;
      },
      expireOpenOlderThan: async () => [],
      nullPayloadsOlderThan: async () => 0,
      newestReceivedAt: async () => ({}),
    },
    ledger: {
      upsertMany: async (id, rows) => {
        let inserted = 0; let updated = 0;
        for (const r of rows) {
          const i = ledger.findIndex((l) => l.connector_id === id && l.external_id === r.external_id);
          if (i >= 0) { ledger[i] = { ...ledger[i], ...r }; updated++; }
          else { ledger.push({ id: `${id}:${r.external_id}`, connector_id: id, ...r }); inserted++; }
        }
        return { inserted, updated };
      },
      query: async () => ({ items: [], hasMore: false }),
      forReconcile: async (sinceIso, untilIso, connectorId) =>
        ledger
          .filter((l) => l.occurred_at >= sinceIso && l.occurred_at <= untilIso && (!connectorId || l.connector_id === connectorId))
          .map((l) => ({ id: l.id, amount: l.amount ?? null, merchant_key: l.merchant ? `mk:${l.merchant.toLowerCase()}` : null, account_ref: l.account_ref ?? null, occurred_at: l.occurred_at })),
      count: async (id) => ledger.filter((r) => !id || r.connector_id === id).length,
      deleteOlderThan: async () => 0,
      newestFetchedAt: async () => ({}),
    },
    findings: {
      open: async (f: FindingInput) => {
        const rec: FindingRecord = { id: `f${findings.length + 1}`, connector_id: f.connector_id, kind: f.kind, summary: f.summary, ref_id: f.ref_id ?? null, opened_at: '', resolved_at: null, resolution: null, delivered: f.delivered ?? 'none' };
        findings.push(rec);
        return rec;
      },
      resolve: async () => null,
      listOpen: async (id) => findings.filter((f) => !f.resolved_at && (!id || f.connector_id === id)),
      deleteResolvedOlderThan: async () => 0,
    },
  };
  return { repos, connectors, creds, ledger, events, findings, clock };
}
