import { describe, it, expect } from 'vitest';
import { connectorSnapshot } from '../snapshot.js';

describe('connectorSnapshot (list_connectors.snapshot)', () => {
  it('projects accounts, connections and freshness from a Financy config', () => {
    const snap = connectorSnapshot({
      accounts: [
        { id: 'a1', providerId: 'discount', accountType: 'CARD', currency: 'ILS', last4: '0034', balances: [{ type: 'current', amount: 1234.5, currency: 'ILS' }] },
        { id: 'a2', providerId: 'discount', accountType: 'CHECKING', currency: 'EUR', last4: null, balances: [] },
      ],
      accounts_fetched_at: '2026-09-06T15:30:00.000Z',
      connections: [{ id: 'c1', providerId: 'discount', status: 'ACTIVE', lastFetchedAt: '2026-09-06T03:00:00.000Z', dataThrough: '2026-09-01', hasError: false }],
      data_through: '2026-09-01',
    });
    expect(snap.accounts).toHaveLength(2);
    expect(snap.accounts[0]).toEqual({ id: 'a1', providerId: 'discount', accountType: 'CARD', currency: 'ILS', last4: '0034', balances: [{ type: 'current', amount: 1234.5, currency: 'ILS' }] });
    expect(snap.accounts[1].balances).toEqual([]);
    expect(snap.connections[0]).toEqual({ id: 'c1', providerId: 'discount', status: 'ACTIVE', lastFetchedAt: '2026-09-06T03:00:00.000Z', dataThrough: '2026-09-01', hasError: false });
    expect(snap.data_through).toBe('2026-09-01');
    expect(snap.accounts_fetched_at).toBe('2026-09-06T15:30:00.000Z');
  });

  it('drops everything outside the allow-list (secrets, cursors, owner info, unknown keys)', () => {
    const snap = connectorSnapshot({
      client_secret: 'nope',
      retention_months: 24,
      cursor: { since: '2026-01-01' },
      accounts: [{ id: 'a1', ownerInfo: { nationalId: '123' }, accountNumber: '1234567890034', last4: '0034', balances: [{ amount: 'x' }] }],
      connections: [{ id: 'c1', error: { body: 'raw' } }],
    });
    expect(JSON.stringify(snap)).not.toMatch(/nope|nationalId|123456|retention|cursor|raw/);
    expect(Object.keys(snap.accounts[0]).sort()).toEqual(['accountType', 'balances', 'currency', 'id', 'last4', 'providerId']);
    expect(snap.accounts[0].balances).toEqual([]);
    expect(Object.keys(snap.connections[0]).sort()).toEqual(['dataThrough', 'hasError', 'id', 'lastFetchedAt', 'providerId', 'status']);
    expect(snap.connections[0].hasError).toBe(false);
  });

  it('is empty-but-well-formed for a missing or malformed config', () => {
    const empty = { accounts: [], connections: [], data_through: null, accounts_fetched_at: null };
    expect(connectorSnapshot(undefined)).toEqual(empty);
    expect(connectorSnapshot({})).toEqual(empty);
    expect(connectorSnapshot('garbage')).toEqual(empty);
    expect(connectorSnapshot({ accounts: 'x', connections: [null, 3, { noId: true }], data_through: 5 })).toEqual(empty);
  });
});
