import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, RequestHandler, Router } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { ContactRoutingResolver } from '../processors/contact-routing.js';
import { createWhatsappWebhookRouter } from '../whatsapp-webhook-route.js';

// ---------------------------------------------------------------------------
// Mocks for the work the route delegates to
// ---------------------------------------------------------------------------
vi.mock('../processors/whatsapp-webhook.js', () => ({
  processWhatsAppWebhook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../processors/whatsapp-contact-webhook.js', () => ({
  processWhatsAppContactWebhook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/whatsapp-user-resolver.js', () => ({
  resolveWhatsAppUserId: vi.fn(),
}));
vi.mock('../utils/data-source-config.js', () => ({
  isSourceEnabled: vi.fn().mockResolvedValue(true),
}));

import { resolveWhatsAppUserId } from '../utils/whatsapp-user-resolver.js';
import { processWhatsAppWebhook } from '../processors/whatsapp-webhook.js';
import { processWhatsAppContactWebhook } from '../processors/whatsapp-contact-webhook.js';
import { isSourceEnabled } from '../utils/data-source-config.js';

const SECRET = 'test-webhook-secret-32-chars-min-len';
const KNOWN_USER = 'user-known';
const KNOWN_INSTANCE = 'instance-known';

// ---------------------------------------------------------------------------
// Handler extraction — mirrors the pattern in chat-conversations.test.ts
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    url: '/',
    originalUrl: '/',
    baseUrl: '',
    path: '/',
    headers: {},
    query: {},
    body: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const res = {
    _status: 200,
    _json: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(data: unknown) {
      this._json = data;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

function buildRouter(opts?: { publishResult?: boolean }): { router: Router; pgPool: Pool; queue: import('../utils/whatsapp-queue.js').WhatsAppQueue } {
  const pgPool = { query: vi.fn() } as unknown as Pool;
  const esClient = { index: vi.fn(), update: vi.fn() } as unknown as Client;
  const matcher = {
    match: vi.fn().mockResolvedValue(null),
    shouldDownloadMedia: vi.fn().mockResolvedValue(false),
    shouldDownloadImages: vi.fn().mockResolvedValue(false),
  } as unknown as ContactRoutingResolver;

  // Broker disabled in tests → publish() returns false so the ingress takes the
  // inline dispatch path these tests assert on.
  const queue = { publish: vi.fn().mockResolvedValue(opts?.publishResult ?? false) } as unknown as import('../utils/whatsapp-queue.js').WhatsAppQueue;

  const router = createWhatsappWebhookRouter({
    pgPool,
    esClient,
    notificationMatcher: matcher,
    webhookSecret: SECRET,
    encryptionKey: undefined,
    queue,
  });
  return { router, pgPool, queue };
}

/** Drive the express Router through its full middleware chain. The router is
 *  itself a function `(req, res, next) => void`. We wait for either the
 *  response to be sent (via .json/.send/.end) or for next() to be invoked
 *  (indicating no route matched). */
async function invoke(router: Router, req: Request, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const wrappedRes = new Proxy(res, {
      get(target, prop) {
        if (prop === 'json' || prop === 'send' || prop === 'end') {
          return (data: unknown) => {
            const fn = (target as unknown as Record<string, (d: unknown) => Response>)[prop as string];
            if (typeof fn === 'function') {
              fn.call(target, data);
            }
            // settle after a microtask so any post-response code in the
            // handler (e.g. logging) doesn't race with the assertions
            queueMicrotask(settle);
            return target;
          };
        }
        return Reflect.get(target, prop);
      },
    });

    const next = (err?: unknown) => {
      if (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }
      settle();
    };

    (router as unknown as (req: Request, res: Response, next: (err?: unknown) => void) => void)(
      req,
      wrappedRes as Response,
      next,
    );
  });
}

// ===========================================================================

describe('createWhatsappWebhookRouter — auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveWhatsAppUserId).mockResolvedValue(KNOWN_USER);
    vi.mocked(isSourceEnabled).mockResolvedValue(true);
  });

  it('returns 401 when X-Webhook-Secret header is missing', async () => {
    const { router } = buildRouter();
    const req = makeReq({ body: { instance: KNOWN_INSTANCE, event: 'messages.upsert', data: {} } });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(401);
    expect(processWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Webhook-Secret header is wrong', async () => {
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': 'wrong-secret' },
      body: { instance: KNOWN_INSTANCE, event: 'messages.upsert', data: {} },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(401);
    expect(processWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it('returns 401 on a length-mismatched secret (no timingSafeEqual crash)', async () => {
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': 'short' },
      body: { instance: KNOWN_INSTANCE, event: 'messages.upsert', data: {} },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(401);
  });

  it('proceeds past auth when X-Webhook-Secret matches', async () => {
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': SECRET },
      body: { instance: KNOWN_INSTANCE, event: 'messages.upsert', data: {} },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(200);
    expect(processWhatsAppWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('createWhatsappWebhookRouter — instance resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isSourceEnabled).mockResolvedValue(true);
  });

  it('returns 400 when payload has no instance field', async () => {
    vi.mocked(resolveWhatsAppUserId).mockResolvedValue(KNOWN_USER);
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': SECRET },
      body: { event: 'messages.upsert', data: {} },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(400);
    expect(processWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it('returns 404 when instance is unknown — no fallback to first user', async () => {
    vi.mocked(resolveWhatsAppUserId).mockResolvedValue(undefined);
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': SECRET },
      body: { instance: 'unknown-instance', event: 'messages.upsert', data: {} },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(404);
    expect(processWhatsAppWebhook).not.toHaveBeenCalled();
    // The resolver must be called WITHOUT a fallback userId
    expect(resolveWhatsAppUserId).toHaveBeenCalledWith(
      expect.anything(),
      'unknown-instance',
      undefined,
    );
  });

  it('forwards the resolved user_id to processWhatsAppWebhook', async () => {
    vi.mocked(resolveWhatsAppUserId).mockResolvedValue('user-resolved');
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': SECRET },
      body: { instance: KNOWN_INSTANCE, event: 'messages.upsert', data: {} },
    });
    const res = makeRes();
    await invoke(router, req, res);

    const call = vi.mocked(processWhatsAppWebhook).mock.calls[0];
    expect(call[3]).toBe('user-resolved');
  });
});

describe('createWhatsappWebhookRouter — source-gating and event routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveWhatsAppUserId).mockResolvedValue(KNOWN_USER);
  });

  it('returns 200 without processing when whatsapp source is disabled', async () => {
    vi.mocked(isSourceEnabled).mockResolvedValue(false);
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': SECRET },
      body: { instance: KNOWN_INSTANCE, event: 'messages.upsert', data: {} },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(200);
    expect(processWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it('routes contacts.upsert to processWhatsAppContactWebhook', async () => {
    vi.mocked(isSourceEnabled).mockResolvedValue(true);
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': SECRET },
      body: { instance: KNOWN_INSTANCE, event: 'contacts.upsert', data: [{ remoteJid: '1@s.whatsapp.net' }] },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(200);
    expect(processWhatsAppContactWebhook).toHaveBeenCalledTimes(1);
    expect(processWhatsAppContactWebhook).toHaveBeenCalledWith(
      expect.anything(),
      KNOWN_USER,
      expect.any(Array),
    );
    expect(processWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it('routes messages.upsert to processWhatsAppWebhook', async () => {
    vi.mocked(isSourceEnabled).mockResolvedValue(true);
    const { router } = buildRouter();
    const req = makeReq({
      headers: { 'x-webhook-secret': SECRET },
      body: { instance: KNOWN_INSTANCE, event: 'messages.upsert', data: { key: { remoteJid: '1@s.whatsapp.net' } } },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(200);
    expect(processWhatsAppWebhook).toHaveBeenCalledTimes(1);
  });

  it('fast-acks to the queue and skips inline processing when the broker is up', async () => {
    vi.mocked(isSourceEnabled).mockResolvedValue(true);
    const { router, queue } = buildRouter({ publishResult: true });
    const req = makeReq({
      headers: { 'x-webhook-secret': SECRET },
      body: { instance: KNOWN_INSTANCE, event: 'messages.upsert', data: { key: { remoteJid: '1@s.whatsapp.net' } } },
    });
    const res = makeRes();
    await invoke(router, req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'queued' });
    expect(queue.publish).toHaveBeenCalledTimes(1);
    // Enqueued → the worker will process it, not the request thread.
    expect(processWhatsAppWebhook).not.toHaveBeenCalled();
  });
});
