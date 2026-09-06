/**
 * SyncService refusal ladder + rate limit, against a small in-memory
 * Repositories fake (behaviour, not call assertions — DECISION-029).
 */
import { describe, it, expect } from 'vitest';
import { runWithRequestContext } from '@ll5/shared';
import { SyncService, SYNC_MIN_INTERVAL_MS, AdapterAuthError } from '../sync.js';
import { ConnectorAdapterRegistry } from '../adapters/registry.js';
import { OtpStore } from '../otp.js';
import type { ConnectorAdapter } from '../adapters/adapter.js';
import { memRepos } from './mem-repos.js';

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
    await inCtx(() => repos.credentials.put('max', 'api_token', { token: 't' }));
    const r = await inCtx(() => sync.run('max'));
    expect(r).toMatchObject({ ok: false, reason: 'pull_failed', status: 'auth_failed', error: '401 from source' });
    expect(connectors.get('max')).toMatchObject({ status: 'auth_failed', consecutive_failures: 1, last_error: '401 from source' });
    expect(findings.map((f) => f.kind)).toEqual(['auth_failed']);
  });
});
