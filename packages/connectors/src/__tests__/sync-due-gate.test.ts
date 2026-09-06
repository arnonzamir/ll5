/**
 * SyncService: the scheduled due gate, the config patch from a pull, the
 * plan_not_eligible code, and cross-connector reconciliation through the
 * sync's maintenance step (a Max card EVENT matched by a FINANCY ledger row).
 */
import { describe, it, expect } from 'vitest';
import { runWithRequestContext } from '@ll5/shared';
import { SyncService, SYNC_MIN_INTERVAL_MS, AdapterPlanError } from '../sync.js';
import { ConnectorAdapterRegistry } from '../adapters/registry.js';
import { OtpStore } from '../otp.js';
import type { ConnectorAdapter, PullResult } from '../adapters/adapter.js';
import { memRepos } from './mem-repos.js';

const inCtx = <T>(fn: () => Promise<T>) => runWithRequestContext({ userId: 'u1' }, fn);
const T0 = Date.parse('2026-09-06T10:00:00.000Z');
const MIN = 60_000;

function adapter(id: string, pull: ConnectorAdapter['pull']): ConnectorAdapter {
  return { id, authType: 'oauth', pull };
}

async function ready(id: string, opts: { schedule_minutes?: number | null } = {}) {
  const m = memRepos();
  await inCtx(() => m.repos.connectors.upsert(id, { enabled: true, ...(opts.schedule_minutes !== undefined ? { schedule_minutes: opts.schedule_minutes } : {}) }));
  await inCtx(() => m.repos.credentials.put(id, 'oauth', { client_id: 'a', client_secret: 'b', user_id: 'c' }));
  return m;
}

describe('SyncService due gate (scheduled calls)', () => {
  it('first scheduled run pulls; the next is not_due until schedule_minutes pass, while a manual run only sees the 10-min rate limit', async () => {
    const m = await ready('financy');
    const registry = new ConnectorAdapterRegistry();
    registry.register(adapter('financy', async () => ({ rows: [], cursor: { since: '2026-09-06' } })));
    let t = T0;
    m.clock.nowIso = new Date(t).toISOString();
    const sync = new SyncService({ repos: m.repos, registry, otp: new OtpStore(), getUserId: () => 'u1', now: () => t });

    expect(await inCtx(() => sync.run('financy', { scheduled: true }))).toMatchObject({ ok: true, pulled: 0 });

    // 15 minutes later (past the rate limit, before the 360-min catalog default): scheduled = not_due, manual = runs.
    t = T0 + 15 * MIN;
    const gated = await inCtx(() => sync.run('financy', { scheduled: true }));
    expect(gated).toMatchObject({ ok: false, reason: 'not_due' });
    expect((gated as { retry_after_seconds?: number }).retry_after_seconds).toBe(345 * 60);
    expect(await inCtx(() => sync.run('financy'))).toMatchObject({ ok: true });

    // Manual within 10 minutes: rate_limited, not not_due.
    t += 5 * MIN;
    expect(await inCtx(() => sync.run('financy'))).toMatchObject({ ok: false, reason: 'rate_limited' });

    // Past the cadence measured from the LAST success (the manual one at T0+15): scheduled runs again.
    m.clock.nowIso = new Date(T0 + 15 * MIN).toISOString();
    t = T0 + 15 * MIN + 360 * MIN;
    expect(await inCtx(() => sync.run('financy', { scheduled: true }))).toMatchObject({ ok: true });
  });

  it('honours the row schedule_minutes override over the catalog default', async () => {
    const m = await ready('financy', { schedule_minutes: 30 });
    const registry = new ConnectorAdapterRegistry();
    registry.register(adapter('financy', async () => ({ rows: [], cursor: null })));
    let t = T0;
    m.clock.nowIso = new Date(t).toISOString();
    const sync = new SyncService({ repos: m.repos, registry, otp: new OtpStore(), getUserId: () => 'u1', now: () => t });
    expect(await inCtx(() => sync.run('financy', { scheduled: true }))).toMatchObject({ ok: true });
    t = T0 + 29 * MIN;
    expect(await inCtx(() => sync.run('financy', { scheduled: true }))).toMatchObject({ ok: false, reason: 'not_due' });
    t = T0 + 31 * MIN;
    expect(await inCtx(() => sync.run('financy', { scheduled: true }))).toMatchObject({ ok: true });
  });

  it('a null row schedule falls back to the catalog cadence; a connector with no cadence anywhere is never due, but still pulls manually', async () => {
    // financy: row null → catalog 360.
    const f = await ready('financy', { schedule_minutes: null });
    const fReg = new ConnectorAdapterRegistry();
    fReg.register(adapter('financy', async () => ({ rows: [], cursor: null })));
    let t = T0;
    f.clock.nowIso = new Date(t).toISOString();
    const fSync = new SyncService({ repos: f.repos, registry: fReg, otp: new OtpStore(), getUserId: () => 'u1', now: () => t });
    expect(await inCtx(() => fSync.run('financy', { scheduled: true }))).toMatchObject({ ok: true });
    t = T0 + 359 * MIN;
    expect(await inCtx(() => fSync.run('financy', { scheduled: true }))).toMatchObject({ ok: false, reason: 'not_due' });

    // municipality: catalog default null (skill-driven) → a scheduled call is never due even with an adapter.
    const m = await ready('municipality');
    const mReg = new ConnectorAdapterRegistry();
    mReg.register(adapter('municipality', async () => ({ rows: [], cursor: null })));
    const mSync = new SyncService({ repos: m.repos, registry: mReg, otp: new OtpStore(), getUserId: () => 'u1', now: () => T0 });
    expect(await inCtx(() => mSync.run('municipality', { scheduled: true }))).toMatchObject({ ok: false, reason: 'not_due' });
    expect(await inCtx(() => mSync.run('municipality'))).toMatchObject({ ok: true });
  });

  it('a failed pull does not move last_success_at, so the next scheduled tick retries', async () => {
    const m = await ready('financy');
    const registry = new ConnectorAdapterRegistry();
    let fail = true;
    registry.register(adapter('financy', async () => { if (fail) throw new Error('ECONNRESET'); return { rows: [], cursor: null }; }));
    let t = T0;
    const sync = new SyncService({ repos: m.repos, registry, otp: new OtpStore(), getUserId: () => 'u1', now: () => t });
    expect(await inCtx(() => sync.run('financy', { scheduled: true }))).toMatchObject({ ok: false, reason: 'pull_failed', status: 'error', error: 'ECONNRESET' });
    expect(m.connectors.get('financy')).toMatchObject({ status: 'error', consecutive_failures: 1, last_success_at: null });
    fail = false;
    t = T0 + SYNC_MIN_INTERVAL_MS;
    expect(await inCtx(() => sync.run('financy', { scheduled: true }))).toMatchObject({ ok: true });
  });
});

describe('SyncService pull outcomes', () => {
  it('merges the adapter config patch into the row config (account snapshot) and keeps existing keys', async () => {
    const m = await ready('financy');
    await inCtx(() => m.repos.connectors.upsert('financy', { config: { retention_months: 12 } }));
    const registry = new ConnectorAdapterRegistry();
    const result: PullResult = { rows: [], cursor: { since: '2026-09-06' }, config: { accounts: [{ id: 'a1', last4: '1234' }] } };
    registry.register(adapter('financy', async () => result));
    const sync = new SyncService({ repos: m.repos, registry, otp: new OtpStore(), getUserId: () => 'u1', now: () => T0 });
    await inCtx(() => sync.run('financy'));
    expect(m.connectors.get('financy')?.config).toEqual({ retention_months: 12, accounts: [{ id: 'a1', last4: '1234' }] });
    expect(m.connectors.get('financy')?.cursor).toEqual({ since: '2026-09-06' });
  });

  it('an AdapterPlanError is pull_failed / error with code plan_not_eligible and no auth finding', async () => {
    const m = await ready('financy');
    const registry = new ConnectorAdapterRegistry();
    registry.register(adapter('financy', async () => { throw new AdapterPlanError('not on plan'); }));
    const sync = new SyncService({ repos: m.repos, registry, otp: new OtpStore(), getUserId: () => 'u1', now: () => T0 });
    const r = await inCtx(() => sync.run('financy'));
    expect(r).toMatchObject({ ok: false, reason: 'pull_failed', status: 'error', code: 'plan_not_eligible', error: 'not on plan' });
    expect(m.findings).toEqual([]);
    expect(m.connectors.get('financy')).toMatchObject({ status: 'error' });
  });
});

describe('cross-connector reconciliation inside sync', () => {
  it('a max card EVENT is matched by a FINANCY ledger row (same amount, same merchant, 2 days apart)', async () => {
    const m = await ready('financy');
    m.events.push({
      id: 'ev-max-1', connector_id: 'max', status: 'open', matched_row_id: null,
      amount: 239.9, merchant_key: 'mk:shufersal', account_ref: '1111', occurred_at: '2026-09-04T18:31:00.000Z',
    });
    m.events.push({
      id: 'ev-isracard-1', connector_id: 'isracard', status: 'open', matched_row_id: null,
      amount: 73.42, merchant_key: 'mk:amazon marketplace', account_ref: '4321', occurred_at: '2026-09-05T09:00:00.000Z',
    });
    const registry = new ConnectorAdapterRegistry();
    registry.register(adapter('financy', async () => ({
      rows: [
        { external_id: 'f1', kind: 'charge', occurred_at: '2026-09-06T00:00:00.000Z', amount: 239.9, currency: 'ILS', merchant: 'Shufersal', account_ref: '1111' },
        // Different merchant string than the app push, same card last 4 → account fallback.
        { external_id: 'f2', kind: 'charge', occurred_at: '2026-09-06T00:00:00.000Z', amount: 73.42, currency: 'ILS', merchant: 'AMZN Mktp US', account_ref: '4321' },
      ],
      cursor: { since: '2026-09-06' },
    })));
    const sync = new SyncService({ repos: m.repos, registry, otp: new OtpStore(), getUserId: () => 'u1', now: () => T0 });
    const r = await inCtx(() => sync.run('financy'));
    expect(r).toMatchObject({ ok: true, pulled: 2, inserted: 2, maintenance: { matched: 2 } });
    expect(m.events.find((e) => e.id === 'ev-max-1')).toMatchObject({ status: 'matched', matched_row_id: 'financy:f1' });
    expect(m.events.find((e) => e.id === 'ev-isracard-1')).toMatchObject({ status: 'matched', matched_row_id: 'financy:f2' });
  });

  it('maintenance for an event-only connector also reconciles against every ledger', async () => {
    const m = memRepos();
    m.events.push({ id: 'ev-cal-1', connector_id: 'cal', status: 'open', matched_row_id: null, amount: 58, merchant_key: 'mk:wolt', account_ref: null, occurred_at: '2026-09-05T20:00:00.000Z' });
    await inCtx(() => m.repos.ledger.upsertMany('financy', [{ external_id: 'w1', kind: 'charge', occurred_at: '2026-09-06T00:00:00.000Z', amount: 58, currency: 'ILS', merchant: 'Wolt' }]));
    const sync = new SyncService({ repos: m.repos, registry: new ConnectorAdapterRegistry(), otp: new OtpStore(), getUserId: () => 'u1', now: () => T0 });
    const r = await inCtx(() => sync.run('cal'));
    expect(r).toMatchObject({ ok: false, reason: 'no_adapter', maintenance: { matched: 1 } });
    expect(m.events[0]).toMatchObject({ status: 'matched', matched_row_id: 'financy:w1' });
  });
});
