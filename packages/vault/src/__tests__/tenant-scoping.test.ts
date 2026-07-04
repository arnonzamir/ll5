import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools, type ToolDependencies } from '../tools/index.js';
import { createTenancyService } from '../tenancy.js';
import type { VaultTenant } from '../gateway.js';

/**
 * DECISION-022 tenant addendum: every credential-touching tool resolves the
 * CALLER's tenant org before any bw query and refuses when unmapped; the
 * lifecycle tools act only on the caller's own tenant (self-scoped userId).
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function makeServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, ..._rest: unknown[]) => {
      const handler = _rest[_rest.length - 1] as ToolHandler;
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

const CRED = {
  itemName: 'School portal',
  url: 'https://portal.school.example.com/login',
  username: 'arnon@example.com',
  password: 'hunter2-super-secret',
};

interface DepsOptions {
  tenant?: VaultTenant | null;
  tenantError?: boolean;
}

function makeDeps(options: DepsOptions = {}) {
  const tenant = options.tenant === undefined ? null : options.tenant;
  const listSites = vi.fn(async (_scope: { orgId: string }) => [{ name: CRED.itemName, domains: ['example.com'] }]);
  const resolveCredential = vi.fn(async () => ({ ok: true as const, credential: { ...CRED } }));
  const performLogin = vi.fn(async () => ({ status: 'success' as const, final_url: 'https://portal.school.example.com/home' }));
  const getTenant = vi.fn(async (_userId: string) => {
    if (options.tenantError) throw new Error('gateway unreachable');
    return tenant;
  });
  const putTenant = vi.fn(async () => undefined);
  const tenancy = {
    provision: vi.fn(async () => ({ status: 'invited' as const, org_id: 'org-1', already_provisioned: false, invite_email_sent: true, message: 'ok' })),
    confirm: vi.fn(async () => ({ membership_status: 'confirmed' as const, message: 'ok' })),
    status: vi.fn(async () => ({ provisioned: true, membership_status: 'active' as const, sites_count: 1, approved_sites: [] })),
  };
  const deps: ToolDependencies = {
    bw: { listSites, resolveCredential },
    gateway: {
      getApprovedSites: async () => ['example.com'],
      requestApproval: async () => undefined,
      getTenant,
      putTenant,
    },
    login: { performLogin, checkLoginStatus: async () => ({ authenticated: false }) },
    sidecar: { status: async () => 'unlocked' as const, sync: async () => undefined },
    tenancy,
  };
  return { deps, listSites, resolveCredential, performLogin, getTenant, putTenant, tenancy };
}

async function callTool(tools: Map<string, ToolHandler>, name: string, args: Record<string, unknown> = {}) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool not registered: ${name}`);
  const res = await handler(args);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe('tenant refusal when unmapped', () => {
  it('list_login_sites refuses with "not provisioned" and never queries bw', async () => {
    const { server, tools } = makeServer();
    const { deps, listSites } = makeDeps({ tenant: null });
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'list_login_sites');
    expect(String(out.error)).toContain('not provisioned');
    expect(listSites).not.toHaveBeenCalled();
  });

  it('browser_login refuses with "not provisioned" and never resolves a credential', async () => {
    const { server, tools } = makeServer();
    const { deps, resolveCredential, performLogin } = makeDeps({ tenant: null });
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'browser_login', { site: 'School portal' });
    expect(out.status).toBe('failed');
    expect(out.reason).toBe('not_provisioned');
    expect(String(out.message)).toContain('provision_vault');
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(performLogin).not.toHaveBeenCalled();
  });

  it('login_status refuses when unmapped', async () => {
    const { server, tools } = makeServer();
    const { deps, resolveCredential } = makeDeps({ tenant: null });
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'login_status', { site: 'School portal' });
    expect(String(out.error)).toContain('not provisioned');
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('browser_login fails CLOSED when the tenant mapping cannot be fetched', async () => {
    const { server, tools } = makeServer();
    const { deps, performLogin } = makeDeps({ tenantError: true });
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'browser_login', { site: 'School portal' });
    expect(out.status).toBe('failed');
    expect(out.reason).toBe('tenant_mapping_unavailable');
    expect(performLogin).not.toHaveBeenCalled();
  });
});

describe('tenant scope propagation (caller-scoped by construction)', () => {
  const TENANT: VaultTenant = { org_id: 'org-A', collection_id: 'col-A', status: 'active' };

  it('resolves the AUTHENTICATED caller and passes their org scope to every bw call', async () => {
    const { server, tools } = makeServer();
    const { deps, listSites, resolveCredential, getTenant } = makeDeps({ tenant: TENANT });
    registerAllTools(server, deps, () => 'user-A');

    await callTool(tools, 'list_login_sites');
    await callTool(tools, 'browser_login', { site: 'School portal' });

    // Mapping lookups only ever use the token's userId.
    for (const call of getTenant.mock.calls) expect(call[0]).toBe('user-A');
    expect(listSites).toHaveBeenCalledWith({ orgId: 'org-A', collectionId: 'col-A' });
    expect(resolveCredential).toHaveBeenCalledWith('School portal', { orgId: 'org-A', collectionId: 'col-A' });
  });
});

describe('lifecycle tools are self-scoped (caller A can never act on B)', () => {
  it('provision_vault provisions the CALLER, with the given email', async () => {
    const { server, tools } = makeServer();
    const { deps, tenancy } = makeDeps();
    registerAllTools(server, deps, () => 'user-A');

    const out = await callTool(tools, 'provision_vault', { user_email: 'arnon@example.com' });
    expect(out.status).toBe('invited');
    expect(tenancy.provision).toHaveBeenCalledTimes(1);
    expect(tenancy.provision).toHaveBeenCalledWith('user-A', 'arnon@example.com');
  });

  it('confirm_vault_membership and vault_status act on the caller only (no user argument exists)', async () => {
    const { server, tools } = makeServer();
    const { deps, tenancy } = makeDeps();
    registerAllTools(server, deps, () => 'user-A');

    await callTool(tools, 'confirm_vault_membership');
    await callTool(tools, 'vault_status');
    expect(tenancy.confirm).toHaveBeenCalledWith('user-A');
    expect(tenancy.status).toHaveBeenCalledWith('user-A');
  });

  it('two different callers hit two different tenants through the same deps', async () => {
    const { deps, tenancy } = makeDeps();
    const a = makeServer();
    registerAllTools(a.server, deps, () => 'user-A');
    const b = makeServer();
    registerAllTools(b.server, deps, () => 'user-B');

    await callTool(a.tools, 'vault_status');
    await callTool(b.tools, 'vault_status');
    expect(tenancy.status).toHaveBeenNthCalledWith(1, 'user-A');
    expect(tenancy.status).toHaveBeenNthCalledWith(2, 'user-B');
  });
});

describe('provision idempotency through the tool layer (real tenancy service)', () => {
  function realTenancyDeps(existing: VaultTenant | null) {
    const createTenantOrg = vi.fn(async () => ({ orgId: 'org-new', collectionId: 'col-new', orgCreated: true, invited: true }));
    const putTenant = vi.fn(async () => undefined);
    const gateway = {
      getApprovedSites: async () => [],
      requestApproval: async () => undefined,
      getTenant: async () => existing,
      putTenant,
    };
    const tenancy = createTenancyService({
      gateway,
      provisioner: { configured: true, createTenantOrg, confirmMember: vi.fn(async () => ({ status: 'confirmed' as const, email: 'x@y.z' })) },
      bw: { listSites: async () => [] },
      sidecar: { status: async () => 'unlocked', sync: async () => undefined },
    });
    return { gateway, tenancy, createTenantOrg, putTenant };
  }

  it('first call creates the org and registers the mapping as invited', async () => {
    const { tenancy, createTenantOrg, putTenant } = realTenancyDeps(null);
    const { server, tools } = makeServer();
    const { deps } = makeDeps();
    registerAllTools(server, { ...deps, tenancy }, () => 'user-A');

    const out = await callTool(tools, 'provision_vault', { user_email: 'arnon@example.com' });
    expect(out.status).toBe('invited');
    expect(out.already_provisioned).toBe(false);
    expect(createTenantOrg).toHaveBeenCalledWith('user-A', 'arnon@example.com');
    expect(putTenant).toHaveBeenCalledWith('user-A', { org_id: 'org-new', collection_id: 'col-new', status: 'invited' });
  });

  it('repeat call is a no-op that reports the existing state (no second org, no invite spam)', async () => {
    const { tenancy, createTenantOrg, putTenant } = realTenancyDeps({ org_id: 'org-A', collection_id: 'col-A', status: 'invited' });
    const { server, tools } = makeServer();
    const { deps } = makeDeps();
    registerAllTools(server, { ...deps, tenancy }, () => 'user-A');

    const out = await callTool(tools, 'provision_vault', { user_email: 'arnon@example.com' });
    expect(out.already_provisioned).toBe(true);
    expect(out.status).toBe('invited');
    expect(out.org_id).toBe('org-A');
    expect(createTenantOrg).not.toHaveBeenCalled();
    expect(putTenant).not.toHaveBeenCalled();
  });
});
