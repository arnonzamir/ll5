import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { generateToken } from '@ll5/shared';
import { createInternalRouter } from '../admin.js';
import { NotProvisionedError } from '../tenancy.js';

/**
 * /internal/tenant/* — the service surface behind the gateway's /me/vault/*
 * wrappers. Must be token-authed and strictly self-scoped (acting user =
 * token claim, never a body field).
 */

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';

function makeTenancy() {
  return {
    provision: vi.fn(async () => ({ status: 'invited' as const, org_id: 'org-1', already_provisioned: false, invite_email_sent: true, message: 'ok' })),
    confirm: vi.fn(async () => ({ membership_status: 'confirmed' as const, message: 'ok' })),
    status: vi.fn(async () => ({ provisioned: true, membership_status: 'active' as const, sites_count: 3, approved_sites: ['example.com'] })),
  };
}

function makeRouter(tenancy = makeTenancy()) {
  const router = createInternalRouter({
    authSecret: AUTH_SECRET,
    apiKey: 'legacy-api-key',
    userId: 'legacy-user',
    tenancy,
  });
  return { router, tenancy };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, query: {}, body: {}, params: {}, ...overrides } as unknown as Request;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res: any = {
    _status: 200,
    _json: null,
    status(code: number) { this._status = code; return this; },
    json(data: unknown) { this._json = data; return this; },
  };
  return res;
}

function getChain(router: ReturnType<typeof createInternalRouter>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return async (req: Request, res: Response) => {
    for (let i = 0; i < handlers.length; i++) {
      let advanced = false;
      const next = () => { advanced = true; };
      await handlers[i](req, res, next);
      if (!advanced) return;
    }
  };
}

const authHeader = (userId: string) => ({ authorization: `Bearer ${generateToken(userId, AUTH_SECRET, 1, 'user')}` });

describe('vault MCP internal tenant routes', () => {
  it('401s without a token on every route', async () => {
    const { router } = makeRouter();
    for (const [method, path] of [
      ['post', '/internal/tenant/provision'],
      ['post', '/internal/tenant/confirm'],
      ['get', '/internal/tenant/status'],
    ] as const) {
      const run = getChain(router, method, path);
      const res = makeRes();
      await run(makeReq({ body: { user_email: 'a@b.co' } }), res);
      expect(res._status).toBe(401);
    }
  });

  it('provision is self-scoped: acting user comes from the token, email from the body', async () => {
    const { router, tenancy } = makeRouter();
    const run = getChain(router, 'post', '/internal/tenant/provision');
    const res = makeRes();
    await run(makeReq({ headers: authHeader('user-A'), body: { user_email: 'Arnon@example.com' } }), res);

    expect(res._status).toBe(200);
    expect((res._json as any).status).toBe('invited');
    expect(tenancy.provision).toHaveBeenCalledWith('user-A', 'Arnon@example.com');
  });

  it('provision 400s on a missing/invalid email', async () => {
    const { router, tenancy } = makeRouter();
    const run = getChain(router, 'post', '/internal/tenant/provision');
    for (const body of [{}, { user_email: 'not-an-email' }, { user_email: '' }]) {
      const res = makeRes();
      await run(makeReq({ headers: authHeader('user-A'), body }), res);
      expect(res._status).toBe(400);
    }
    expect(tenancy.provision).not.toHaveBeenCalled();
  });

  it('confirm is self-scoped and 409s when not provisioned', async () => {
    const tenancy = makeTenancy();
    tenancy.confirm.mockRejectedValueOnce(new NotProvisionedError());
    const { router } = makeRouter(tenancy);
    const run = getChain(router, 'post', '/internal/tenant/confirm');

    const res409 = makeRes();
    await run(makeReq({ headers: authHeader('user-A') }), res409);
    expect(res409._status).toBe(409);

    const resOk = makeRes();
    await run(makeReq({ headers: authHeader('user-A') }), resOk);
    expect(resOk._status).toBe(200);
    expect((resOk._json as any).membership_status).toBe('confirmed');
    expect(tenancy.confirm).toHaveBeenCalledWith('user-A');
  });

  it('status returns the tenancy snapshot for the token user', async () => {
    const { router, tenancy } = makeRouter();
    const run = getChain(router, 'get', '/internal/tenant/status');
    const res = makeRes();
    await run(makeReq({ headers: authHeader('user-B') }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ provisioned: true, sites_count: 3 });
    expect(tenancy.status).toHaveBeenCalledWith('user-B');
  });
});
