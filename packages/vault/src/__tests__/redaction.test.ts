import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeError, assertNoSecrets } from '../utils/redact.js';
import { registerAllTools, type ToolDependencies } from '../tools/index.js';

const PASSWORD = 'hunter2-$uper.[secret]*';
const USERNAME = 'machine-user@example.com';

describe('redaction discipline (DECISION-022 §5)', () => {
  describe('sanitizeError', () => {
    it('strips secret values out of error messages', () => {
      const err = new Error(`fill failed for value "${PASSWORD}" on selector input`);
      const msg = sanitizeError(err, [PASSWORD]);
      expect(msg).not.toContain(PASSWORD);
      expect(msg).toContain('[redacted]');
    });

    it('is not confused by regex-special characters in the secret', () => {
      const msg = sanitizeError(new Error(`x ${PASSWORD} y ${PASSWORD} z`), [PASSWORD]);
      expect(msg).toBe('x [redacted] y [redacted] z');
    });

    it('drops stack traces and truncates long messages', () => {
      const long = new Error('boom '.repeat(200));
      const msg = sanitizeError(long, []);
      expect(msg.length).toBeLessThanOrEqual(301);
      expect(msg).not.toContain('\n');
    });

    it('ignores empty/undefined secrets safely', () => {
      expect(sanitizeError(new Error('plain'), [undefined, null, ''])).toBe('plain');
    });
  });

  describe('assertNoSecrets', () => {
    it('passes clean payloads through untouched', () => {
      const payload = { status: 'success', final_url: 'https://example.com/home' };
      expect(assertNoSecrets(payload, [PASSWORD, USERNAME])).toEqual(payload);
    });

    it('replaces the entire payload if a secret leaked into it', () => {
      const leaky = { status: 'failed', reason: `server said: ${PASSWORD}` };
      const out = assertNoSecrets(leaky, [PASSWORD]);
      expect(JSON.stringify(out)).not.toContain(PASSWORD);
      expect(out).toEqual({ status: 'failed', reason: 'redaction_violation' });
    });
  });

  describe('tool results never contain credential material', () => {
    type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

    function setup(loginResult: Record<string, unknown>) {
      const tools = new Map<string, ToolHandler>();
      const server = {
        tool: (name: string, ...rest: unknown[]) => {
          tools.set(name, rest[rest.length - 1] as ToolHandler);
        },
      } as unknown as McpServer;
      const deps: ToolDependencies = {
        bw: {
          listSites: async () => [{ name: 'School portal', domains: ['example.com'] }],
          resolveCredential: async () => ({
            ok: true,
            credential: {
              itemName: 'School portal',
              url: 'https://example.com/login',
              username: USERNAME,
              password: PASSWORD,
            },
          }),
        },
        gateway: {
          getApprovedSites: async () => ['example.com'],
          requestApproval: vi.fn(async () => undefined),
          getTenant: async () => ({ org_id: 'org-1', collection_id: 'col-1', status: 'active' as const }),
          putTenant: async () => undefined,
        },
        login: {
          performLogin: async () => loginResult as never,
          checkLoginStatus: async () => ({ authenticated: true, final_url: 'https://example.com/home' }),
        },
        sidecar: { status: async () => 'unlocked' as const, sync: async () => undefined },
        tenancy: {
          provision: async () => ({ status: 'invited' as const, org_id: 'org-1', already_provisioned: false, invite_email_sent: true, message: 'ok' }),
          confirm: async () => ({ membership_status: 'confirmed' as const, message: 'ok' }),
          status: async () => ({ provisioned: true, membership_status: 'active' as const, sites_count: 1, approved_sites: [] }),
        },
      };
      registerAllTools(server, deps, () => 'u1');
      return tools;
    }

    async function call(tools: Map<string, ToolHandler>, name: string, args: Record<string, unknown> = {}) {
      const res = await tools.get(name)!(args);
      return res.content[0].text;
    }

    it('browser_login result has no username/password on the happy path', async () => {
      const tools = setup({ status: 'success', final_url: 'https://example.com/home' });
      const text = await call(tools, 'browser_login', { site: 'School portal' });
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(USERNAME);
      const parsed = JSON.parse(text);
      expect(Object.keys(parsed).sort()).toEqual(['final_url', 'site', 'status']);
    });

    it('browser_login result is scrubbed even if the login runner leaks a secret', async () => {
      // Simulate a buggy runner that echoes the password into a field.
      const tools = setup({ status: 'failed', reason: `page said ${PASSWORD}` });
      const text = await call(tools, 'browser_login', { site: 'School portal' });
      expect(text).not.toContain(PASSWORD);
      expect(JSON.parse(text).reason).toBe('redaction_violation');
    });

    it('list_login_sites exposes names and domains ONLY', async () => {
      const tools = setup({ status: 'success' });
      const text = await call(tools, 'list_login_sites');
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(USERNAME);
      const parsed = JSON.parse(text) as { sites: Array<Record<string, unknown>> };
      expect(parsed.sites).toEqual([{ name: 'School portal', domains: ['example.com'] }]);
      for (const site of parsed.sites) {
        expect(Object.keys(site).sort()).toEqual(['domains', 'name']);
      }
    });

    it('login_status result has no credential material', async () => {
      const tools = setup({ status: 'success' });
      const text = await call(tools, 'login_status', { site: 'School portal' });
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(USERNAME);
    });
  });
});
