import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BwClient } from '../bw/client.js';

/**
 * BwClient org scoping (DECISION-022 tenant addendum): the machine account
 * sees every tenant org, so the client must be incapable of returning another
 * tenant's items by construction — org-scoped queries + a hard assertion on
 * every returned item's organizationId.
 */

const BASE = 'http://127.0.0.1:8087';

const ORG_A = 'org-aaaa';
const ORG_B = 'org-bbbb';
const COL_A = 'col-aaaa';

function bwEnvelope<T>(data: T[]) {
  return { success: true, data: { data } };
}

function makeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'item-1',
    name: 'School portal',
    type: 1,
    organizationId: ORG_A,
    collectionIds: [COL_A],
    login: {
      username: 'user@example.com',
      password: 'secret-password',
      uris: [{ uri: 'https://portal.school.example.com/login' }],
    },
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(routes: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url).replace(BASE, '');
    for (const [prefix, body] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        return { ok: true, json: async () => body } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
}

describe('BwClient tenant scoping', () => {
  it('passes organizationId + collectionId filters to bw serve', async () => {
    respond({
      '/list/object/org-collections': bwEnvelope([{ id: COL_A, name: 'agent' }]),
      '/list/object/items': bwEnvelope([makeItem()]),
    });
    const client = new BwClient(BASE, 'agent');
    const sites = await client.listSites({ orgId: ORG_A, collectionId: COL_A });

    expect(sites).toEqual([{ name: 'School portal', domains: ['example.com'] }]);
    const itemsCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/list/object/items'))!;
    expect(itemsCall).toContain(`organizationId=${ORG_A}`);
    expect(itemsCall).toContain(`collectionId=${COL_A}`);
  });

  it('drops items whose organizationId is another tenant, even if bw serve returns them', async () => {
    respond({
      '/list/object/org-collections': bwEnvelope([{ id: COL_A, name: 'agent' }]),
      '/list/object/items': bwEnvelope([
        makeItem(),
        makeItem({ id: 'item-2', name: 'Other tenant bank', organizationId: ORG_B }),
        makeItem({ id: 'item-3', name: 'Personal item', organizationId: null }),
      ]),
    });
    const client = new BwClient(BASE, 'agent');
    const sites = await client.listSites({ orgId: ORG_A, collectionId: COL_A });

    expect(sites.map((s) => s.name)).toEqual(['School portal']);
  });

  it('resolveCredential never matches an out-of-scope item (not even as a candidate)', async () => {
    respond({
      '/list/object/org-collections': bwEnvelope([{ id: COL_A, name: 'agent' }]),
      '/list/object/items': bwEnvelope([
        makeItem({ id: 'item-2', name: 'Other tenant bank', organizationId: ORG_B }),
      ]),
    });
    const client = new BwClient(BASE, 'agent');
    const result = await client.resolveCredential('Other tenant bank', { orgId: ORG_A, collectionId: COL_A });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.candidates).toEqual([]);
    }
  });

  it('refuses when the mapped collection_id does not belong to the tenant org', async () => {
    respond({
      '/list/object/org-collections': bwEnvelope([{ id: COL_A, name: 'agent' }]),
      '/list/object/items': bwEnvelope([makeItem()]),
    });
    const client = new BwClient(BASE, 'agent');
    await expect(client.listSites({ orgId: ORG_A, collectionId: 'col-of-someone-else' }))
      .rejects.toThrow(/not part of the tenant organization/);
  });

  it('resolves the "agent" collection by name when the mapping has no collection_id (legacy seed row)', async () => {
    respond({
      '/list/object/org-collections': bwEnvelope([
        { id: 'col-other', name: 'default' },
        { id: COL_A, name: 'agent' },
      ]),
      '/list/object/items': bwEnvelope([makeItem()]),
    });
    const client = new BwClient(BASE, 'agent');
    const sites = await client.listSites({ orgId: ORG_A, collectionId: null });
    expect(sites).toHaveLength(1);
    const itemsCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/list/object/items'))!;
    expect(itemsCall).toContain(`collectionId=${COL_A}`);
  });

  it('returns the credential for an in-scope item (happy path)', async () => {
    respond({
      '/list/object/org-collections': bwEnvelope([{ id: COL_A, name: 'agent' }]),
      '/list/object/items': bwEnvelope([makeItem()]),
    });
    const client = new BwClient(BASE, 'agent');
    const result = await client.resolveCredential('school portal', { orgId: ORG_A, collectionId: COL_A });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.itemName).toBe('School portal');
      expect(result.credential.password).toBe('secret-password');
    }
  });
});
