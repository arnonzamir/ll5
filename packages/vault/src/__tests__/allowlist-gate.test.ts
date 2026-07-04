import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools, type ToolDependencies } from '../tools/index.js';

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

function makeDeps(overrides: Partial<{
  approvedSites: string[];
  approvedSitesError: boolean;
}> = {}): { deps: ToolDependencies; performLogin: ReturnType<typeof vi.fn>; requestApproval: ReturnType<typeof vi.fn> } {
  const performLogin = vi.fn(async () => ({ status: 'success' as const, final_url: 'https://portal.school.example.com/home' }));
  const requestApproval = vi.fn(async () => undefined);
  const deps: ToolDependencies = {
    bw: {
      listSites: async () => [{ name: CRED.itemName, domains: ['example.com'] }],
      resolveCredential: async () => ({ ok: true, credential: { ...CRED } }),
    },
    gateway: {
      getApprovedSites: async () => {
        if (overrides.approvedSitesError) throw new Error('gateway unreachable');
        return overrides.approvedSites ?? [];
      },
      requestApproval,
    },
    login: {
      performLogin,
      checkLoginStatus: async () => ({ authenticated: false }),
    },
    sidecar: {
      status: async () => 'unlocked' as const,
      sync: async () => undefined,
    },
  };
  return { deps, performLogin, requestApproval };
}

async function callTool(tools: Map<string, ToolHandler>, name: string, args: Record<string, unknown>) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool not registered: ${name}`);
  const res = await handler(args);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe('browser_login allowlist gate (DECISION-022 hard rule #2)', () => {
  it('refuses an unapproved domain, files an approval request, and never touches the browser', async () => {
    const { server, tools } = makeServer();
    const { deps, performLogin, requestApproval } = makeDeps({ approvedSites: ['other.com'] });
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'browser_login', { site: 'School portal' });

    expect(out.status).toBe('approval_required');
    expect(out.domain).toBe('example.com');
    expect(requestApproval).toHaveBeenCalledWith('u1', 'example.com', 'School portal');
    expect(performLogin).not.toHaveBeenCalled();
  });

  it('proceeds to the login runner when the domain is approved', async () => {
    const { server, tools } = makeServer();
    const { deps, performLogin, requestApproval } = makeDeps({ approvedSites: ['example.com'] });
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'browser_login', { site: 'School portal' });

    expect(out.status).toBe('success');
    expect(out.final_url).toBe('https://portal.school.example.com/home');
    expect(performLogin).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('a full-URL allowlist entry approves its registrable domain', async () => {
    const { server, tools } = makeServer();
    const { deps, performLogin } = makeDeps({ approvedSites: ['https://www.example.com/somewhere'] });
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'browser_login', { site: 'School portal' });
    expect(out.status).toBe('success');
    expect(performLogin).toHaveBeenCalled();
  });

  it('fails CLOSED when the allowlist cannot be fetched — no fill, no approval spam', async () => {
    const { server, tools } = makeServer();
    const { deps, performLogin, requestApproval } = makeDeps({ approvedSitesError: true });
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'browser_login', { site: 'School portal' });

    expect(out.status).toBe('failed');
    expect(out.reason).toBe('allowlist_unavailable');
    expect(performLogin).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('refuses to log in when the vault sidecar is not unlocked', async () => {
    const { server, tools } = makeServer();
    const { deps, performLogin } = makeDeps({ approvedSites: ['example.com'] });
    deps.sidecar.status = async () => 'locked' as const;
    registerAllTools(server, deps, () => 'u1');

    const out = await callTool(tools, 'browser_login', { site: 'School portal' });
    expect(out.status).toBe('failed');
    expect(performLogin).not.toHaveBeenCalled();
  });
});
