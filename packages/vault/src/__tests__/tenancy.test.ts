import { describe, it, expect, vi } from 'vitest';
import { createTenancyService, NotProvisionedError } from '../tenancy.js';
import type { VaultTenant } from '../gateway.js';
import type { MemberConfirmResult } from '../provision.js';
import { tenantOrgName } from '../provision.js';

function makeDeps(options: {
  tenant?: VaultTenant | null;
  configured?: boolean;
  confirmResult?: MemberConfirmResult;
  sidecarStatus?: string;
  sites?: Array<{ name: string }>;
} = {}) {
  const createTenantOrg = vi.fn(async () => ({ orgId: 'org-new', collectionId: 'col-new', orgCreated: true, invited: true }));
  const confirmMember = vi.fn(async () => options.confirmResult ?? ({ status: 'confirmed', email: 'a@b.c' } as MemberConfirmResult));
  const putTenant = vi.fn(async () => undefined);
  const sync = vi.fn(async () => undefined);
  const deps = {
    gateway: {
      getApprovedSites: async () => ['example.com'],
      requestApproval: async () => undefined,
      getTenant: vi.fn(async () => options.tenant ?? null),
      putTenant,
    },
    provisioner: { configured: options.configured ?? true, createTenantOrg, confirmMember },
    bw: { listSites: vi.fn(async () => options.sites ?? [{ name: 'a' }, { name: 'b' }]) },
    sidecar: { status: async () => options.sidecarStatus ?? 'unlocked', sync },
  };
  return { deps, createTenantOrg, confirmMember, putTenant, sync };
}

describe('tenantOrgName', () => {
  it('is "LL5 <first-8-of-userId>"', () => {
    expect(tenantOrgName('f08f46b3-0a9c-41ae-9e6a-294c697424e4')).toBe('LL5 f08f46b3');
    expect(tenantOrgName('f08f46b3-0a9c-41ae-9e6a-294c697424e4', 'X')).toBe('X f08f46b3');
  });
});

describe('tenancy.provision', () => {
  it('creates org + collection, registers the mapping as invited, and syncs the sidecar', async () => {
    const { deps, createTenantOrg, putTenant, sync } = makeDeps({ tenant: null });
    const svc = createTenancyService(deps);

    const out = await svc.provision('user-A', 'Arnon@Example.com ');
    expect(out).toMatchObject({ status: 'invited', org_id: 'org-new', already_provisioned: false, invite_email_sent: true });
    expect(createTenantOrg).toHaveBeenCalledWith('user-A', 'Arnon@Example.com ');
    expect(putTenant).toHaveBeenCalledWith('user-A', { org_id: 'org-new', collection_id: 'col-new', status: 'invited' });
    expect(sync).toHaveBeenCalled();
  });

  it('is idempotent: an existing mapping short-circuits (no org create, no mapping write)', async () => {
    const { deps, createTenantOrg, putTenant } = makeDeps({
      tenant: { org_id: 'org-A', collection_id: 'col-A', status: 'active' },
    });
    const svc = createTenancyService(deps);

    const out = await svc.provision('user-A', 'arnon@example.com');
    expect(out).toMatchObject({ status: 'active', org_id: 'org-A', already_provisioned: true, invite_email_sent: false });
    expect(createTenantOrg).not.toHaveBeenCalled();
    expect(putTenant).not.toHaveBeenCalled();
  });

  it('throws a clear error when provisioning is unconfigured (BW_EMAIL/BW_PASSWORD missing)', async () => {
    const { deps, createTenantOrg } = makeDeps({ tenant: null, configured: false });
    const svc = createTenancyService(deps);
    await expect(svc.provision('user-A', 'a@b.c')).rejects.toThrow(/not configured/);
    expect(createTenantOrg).not.toHaveBeenCalled();
  });
});

describe('tenancy.confirm', () => {
  it('throws NotProvisionedError when unmapped', async () => {
    const { deps, confirmMember } = makeDeps({ tenant: null });
    const svc = createTenancyService(deps);
    await expect(svc.confirm('user-A')).rejects.toBeInstanceOf(NotProvisionedError);
    expect(confirmMember).not.toHaveBeenCalled();
  });

  it('confirms the accepted member and flips the mapping to active', async () => {
    const { deps, confirmMember, putTenant } = makeDeps({
      tenant: { org_id: 'org-A', collection_id: 'col-A', status: 'invited' },
      confirmResult: { status: 'confirmed', email: 'arnon@example.com' },
    });
    const svc = createTenancyService(deps);

    const out = await svc.confirm('user-A');
    expect(out.membership_status).toBe('confirmed');
    expect(confirmMember).toHaveBeenCalledWith('org-A');
    expect(putTenant).toHaveBeenCalledWith('user-A', { org_id: 'org-A', collection_id: 'col-A', status: 'active' });
  });

  it('reports invited (and does NOT touch the mapping) when the user has not accepted yet', async () => {
    const { deps, putTenant } = makeDeps({
      tenant: { org_id: 'org-A', collection_id: 'col-A', status: 'invited' },
      confirmResult: { status: 'not_accepted_yet', email: 'arnon@example.com' },
    });
    const svc = createTenancyService(deps);

    const out = await svc.confirm('user-A');
    expect(out.membership_status).toBe('invited');
    expect(out.message).toContain('not accepted');
    expect(putTenant).not.toHaveBeenCalled();
  });

  it('does not rewrite an already-active mapping', async () => {
    const { deps, putTenant } = makeDeps({
      tenant: { org_id: 'org-A', collection_id: 'col-A', status: 'active' },
      confirmResult: { status: 'already_confirmed', email: 'arnon@example.com' },
    });
    const svc = createTenancyService(deps);
    const out = await svc.confirm('user-A');
    expect(out.membership_status).toBe('confirmed');
    expect(putTenant).not.toHaveBeenCalled();
  });
});

describe('tenancy.status', () => {
  it('reports unprovisioned when unmapped', async () => {
    const { deps } = makeDeps({ tenant: null });
    const svc = createTenancyService(deps);
    expect(await svc.status('user-A')).toEqual({
      provisioned: false,
      membership_status: null,
      sites_count: null,
      approved_sites: [],
    });
  });

  it('reports lifecycle + tenant-scoped sites_count + approved_sites when mapped', async () => {
    const { deps } = makeDeps({ tenant: { org_id: 'org-A', collection_id: 'col-A', status: 'active' } });
    const svc = createTenancyService(deps);

    const out = await svc.status('user-A');
    expect(out).toEqual({
      provisioned: true,
      membership_status: 'active',
      sites_count: 2,
      approved_sites: ['example.com'],
    });
    expect(deps.bw.listSites).toHaveBeenCalledWith({ orgId: 'org-A', collectionId: 'col-A' });
  });

  it('degrades sites_count to null when the sidecar is not unlocked', async () => {
    const { deps } = makeDeps({
      tenant: { org_id: 'org-A', collection_id: 'col-A', status: 'active' },
      sidecarStatus: 'locked',
    });
    const svc = createTenancyService(deps);
    const out = await svc.status('user-A');
    expect(out.sites_count).toBeNull();
    expect(deps.bw.listSites).not.toHaveBeenCalled();
  });
});
