/**
 * SyncService refusal ladder + rate limit, against a small in-memory
 * Repositories fake (behaviour, not call assertions — DECISION-029).
 */
import { describe, it, expect } from 'vitest';
import { runWithRequestContext } from '@ll5/shared';
import { SyncService, SYNC_MIN_INTERVAL_MS, AdapterAuthError } from '../sync.js';
import { ConnectorAdapterRegistry } from '../adapters/registry.js';
import { OtpStore } from '../otp.js';
import type { Repositories } from '../repositories/postgres/index.js';
import type { ConnectorRow, FindingInput, FindingRecord, LedgerRowInput } from '../types.js';
import type { ConnectorAdapter } from '../adapters/adapter.js';

function memRepos() {
  const connectors = new Map<string, ConnectorRow>();
  const creds = new Map<string, Record<string, unknown>>();
  const ledger: Array<{ connector_id: string } & LedgerRowInput> = [];
  const findings: FindingRecord[] = [];
  const row = (id: string, p: Partial<ConnectorRow> = {}): ConnectorRow => ({
    connector_id: id, enabled: false, status: 'unconfigured', schedule_minutes: null, last_success_at: null,
    last_error_at: null, last_error: null, consecutive_failures: 0, cursor: null, config: {}, created_at: '', updated_at: '', ...p,
  });
  const repos: Repositories = {
    connectors: {
      list: async () => [...connectors.values()],
      get: async (id) => connectors.get(id) ?? null,
      upsert: async (id, patch) => {
        const r = { ...(connectors.get(id) ?? row(id)), ...patch, config: patch.config ?? connectors.get(id)?.config ?? {} } as ConnectorRow;
        connectors.set(id, r);
        return r;
      },
      recordSync: async (id, o) => {
        const r = connectors.get(id) ?? row(id);
        connectors.set(id, o.ok
          ? { ...r, status: o.status, last_success_at: 'now', last_error: null, consecutive_failures: 0, cursor: o.cursor ?? r.cursor }
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
      openForReconcile: async () => [],
      markMatched: async () => 0,
      expireOpenOlderThan: async () => [],
      nullPayloadsOlderThan: async () => 0,
      newestReceivedAt: async () => ({}),
    },
    ledger: {
      upsertMany: async (id, rows) => { for (const r of rows) ledger.push({ connector_id: id, ...r }); return { inserted: rows.length, updated: 0 }; },
      query: async () => ({ items: [], hasMore: false }),
      forReconcile: async () => [],
      count: async (id) => ledger.filter((r) => r.connector_id === id).length,
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
  return { repos, connectors, creds, ledger, findings };
}

const inCtx = <T>(fn: () => Promise<T>) => runWithRequestContext({ userId: 'u1' }, fn);

function fakeAdapter(id: string, impl?: ConnectorAdapter['pull']): ConnectorAdapter {
  return {
    id,
    authType: 'api_token',
    pull: impl ?? (async (_c, cursor) => ({ rows: [{ external_id: 'x1', kind: 'charge', occurred_at: '2026-09-06T10:00:00Z', amount: 5, currency: 'ILS', merchant: 'Wolt' }], cursor: { n: Number((cursor as { n?: number } | null)?.n ?? 0) + 1 } })),
  };
}

describe('SyncService refusals', () => {
  it('a connector without an adapter is refused with no_adapter (Phase 0: every connector), but maintenance still runs', async () => {
    const { repos } = memRepos();
    const sync = new SyncService({ repos, registry: new ConnectorAdapterRegistry(), otp: new OtpStore(), getUserId: () => 'u1' });
    const r = await inCtx(() => sync.run('cal'));
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, connector_id: 'cal', reason: 'no_adapter' });
    expect((r as { maintenance?: unknown }).maintenance).toMatchObject({ matched: 0, expired: 0 });
  });

  it('disabled → no_credentials → ok, then rate_limited within 10 minutes', async () => {
    const { repos, connectors } = memRepos();
    const registry = new ConnectorAdapterRegistry();
    registry.register(fakeAdapter('bank'));
    let t = 1_000_000;
    const sync = new SyncService({ repos, registry, otp: new OtpStore(), getUserId: () => 'u1', now: () => t });

    expect(await inCtx(() => sync.run('bank'))).toMatchObject({ ok: false, reason: 'disabled' });
    await inCtx(() => repos.connectors.upsert('bank', { enabled: true }));
    expect(await inCtx(() => sync.run('bank'))).toMatchObject({ ok: false, reason: 'no_credentials' });
    await inCtx(() => repos.credentials.put('bank', 'api_token', { token: 't' }));

    const ok = await inCtx(() => sync.run('bank'));
    expect(ok).toMatchObject({ ok: true, connector_id: 'bank', pulled: 1, inserted: 1, updated: 0 });
    expect(connectors.get('bank')).toMatchObject({ status: 'ok', cursor: { n: 1 }, consecutive_failures: 0 });

    t += SYNC_MIN_INTERVAL_MS - 1000;
    const limited = await inCtx(() => sync.run('bank'));
    expect(limited).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect((limited as { retry_after_seconds?: number }).retry_after_seconds).toBe(1);

    t += 1000;
    expect(await inCtx(() => sync.run('bank'))).toMatchObject({ ok: true, pulled: 1 });
    expect(connectors.get('bank')?.cursor).toEqual({ n: 2 });
  });

  it('an AdapterAuthError marks the connector auth_failed and opens one auth_failed finding', async () => {
    const { repos, connectors, findings } = memRepos();
    const registry = new ConnectorAdapterRegistry();
    registry.register(fakeAdapter('max', async () => { throw new AdapterAuthError('401 from source'); }));
    const sync = new SyncService({ repos, registry, otp: new OtpStore(), getUserId: () => 'u1' });
    await inCtx(() => repos.connectors.upsert('max', { enabled: true }));
    await inCtx(() => repos.credentials.put('max', 'scraper_credentials', { user: 'u', password: 'p' }));
    const r = await inCtx(() => sync.run('max'));
    expect(r).toMatchObject({ ok: false, reason: 'pull_failed', status: 'auth_failed', error: '401 from source' });
    expect(connectors.get('max')).toMatchObject({ status: 'auth_failed', consecutive_failures: 1, last_error: '401 from source' });
    expect(findings.map((f) => f.kind)).toEqual(['auth_failed']);
  });
});
