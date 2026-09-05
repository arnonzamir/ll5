import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvolutionClient } from '../clients/evolution.client.js';

const warnSpy = vi.fn();
const errorSpy = vi.fn();
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => warnSpy(...a),
    error: (...a: unknown[]) => errorSpy(...a),
    debug: vi.fn(),
  },
}));

describe('EvolutionClient.createInstance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provisions the webhook with base64:false + lifecycle events (DECISION-024)', async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init?: unknown) => {
      sentBody = JSON.parse(String((init as RequestInit).body));
      return {
        ok: true,
        status: 201,
        json: async () => ({ instance: { instanceId: 'i1', instanceName: 'll5' }, hash: 'APIKEY', qrcode: { base64: null } }),
      } as unknown as Response;
    });

    await EvolutionClient.createInstance('https://evo.example', 'GLOBAL', {
      instanceName: 'll5',
      webhookUrl: 'https://gateway.example/webhook/whatsapp',
      webhookSecret: 'S3CR3T',
    });

    const webhook = sentBody?.webhook as Record<string, unknown>;
    // The exact config a re-pair must NOT revert — this was the 2026-07-06 jam.
    expect(webhook.base64).toBe(false);
    expect(webhook.events).toContain('APPLICATION_STARTUP');
    expect(webhook.events).toContain('LOGOUT_INSTANCE');
    expect((webhook.headers as Record<string, string>)['X-Webhook-Secret']).toBe('S3CR3T');
  });
});

describe('EvolutionClient.connectionState', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    errorSpy.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns logged-out state when the API responds with a non-open state (200)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ instance: { state: 'close' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new EvolutionClient('https://evo.example.com', 'll5', 'k');
    const res = await client.connectionState();
    expect(res.state).toBe('close');
  });

  it('surfaces a transient transport error distinctly (does NOT masquerade as logged-out disconnected)', async () => {
    // A network blip: fetch rejects. The old behaviour swallowed this and
    // returned {state:'disconnected'}, making it indistinguishable from a
    // genuine logout. The fix must make the transient case distinguishable.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    const client = new EvolutionClient('https://evo.example.com', 'll5', 'k');

    let thrown: unknown;
    let result: { state: string } | undefined;
    try {
      result = await client.connectionState();
    } catch (e) {
      thrown = e;
    }

    // Acceptable contract: either it throws (propagates), or it returns a
    // dedicated transient state — but it must NOT silently return 'disconnected'.
    if (thrown) {
      expect(String((thrown as Error).message)).toContain('ECONNRESET');
    } else {
      expect(result).toBeDefined();
      expect(result!.state).not.toBe('disconnected');
      expect(result!.state).toBe('transient_error');
    }

    // And it must log the transient case distinctly from a logout.
    expect(warnSpy.mock.calls.some((c) => JSON.stringify(c).includes('transient'))).toBe(true);
  });
});

describe('EvolutionClient.fetchMessages — response envelopes (ISS-028)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const mockFetch = (payload: unknown) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => payload } as unknown as Response);

  it('unwraps the v2 envelope { messages: { total, pages, records } } — the live shape that used to read as []', async () => {
    mockFetch({ messages: { total: 11451, pages: 229, currentPage: 1, records: [{ key: { id: 'm1', fromMe: false, remoteJid: 'g@g.us' }, messageTimestamp: 1788593922 }] } });
    const c = new EvolutionClient('https://evo.example', 'll5', 'k');
    const out = await c.fetchMessages('g@g.us', 3);
    expect(out).toHaveLength(1);
    expect(out[0].key.id).toBe('m1');
  });

  it('still accepts the legacy { messages: [...] } and raw-array shapes, and returns [] for anything else', async () => {
    mockFetch({ messages: [{ key: { id: 'a', fromMe: true, remoteJid: 'x' } }] });
    expect(await new EvolutionClient('https://evo.example', 'll5', 'k').fetchMessages('x')).toHaveLength(1);
    mockFetch([{ key: { id: 'b', fromMe: true, remoteJid: 'x' } }]);
    expect(await new EvolutionClient('https://evo.example', 'll5', 'k').fetchMessages('x')).toHaveLength(1);
    mockFetch({ messages: { total: 0 } });
    expect(await new EvolutionClient('https://evo.example', 'll5', 'k').fetchMessages('x')).toEqual([]);
  });
});
