import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

// Mock logger so test output stays clean.
vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { triggerAgent, getAgentSessionId, getAgentSessionForWorker } from '../utils/agent-trigger.js';

function mockPool(rows: Array<Record<string, unknown>>): Pool {
  const query = vi.fn(async () => ({ rows }));
  return { query } as unknown as Pool;
}

describe('agent-trigger (dual-run-variant Phase 2)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    delete process.env.OPENCODE_SERVER_URL;
    globalThis.fetch = originalFetch;
  });

  // --- triggerAgent ---

  it('is a no-op when OPENCODE_SERVER_URL is empty (Claude Code variant)', async () => {
    delete process.env.OPENCODE_SERVER_URL;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await triggerAgent('sess-123', { content: 'hello' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when sessionId is null', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await triggerAgent(null, { content: 'hello' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes an HTTP POST to prompt_async when OPENCODE_SERVER_URL is set', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const fetchSpy = vi.fn(async () =>
      new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await triggerAgent('sess-abc', { content: 'do the thing' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://agent:4096/session/sess-abc/prompt_async');
    expect(init).toMatchObject({ method: 'POST' });
    const body = JSON.parse(init.body as string);
    expect(body.parts).toEqual([{ type: 'text', text: 'do the thing' }]);
    expect(body.context).toBeUndefined();
  });

  it('prepends metadata as a [meta] parts entry BEFORE the content', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const fetchSpy = vi.fn(async () =>
      new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    const metadata = {
      source: { platform: 'whatsapp', remote_jid: '123@s.whatsapp.net' },
      scheduler: { scheduler: 'evening-close', event_id: 'evt_1', fired_at: '2026-07-08T20:30:00Z' },
    };
    await triggerAgent('sess-meta', { content: 'run skill', metadata });

    const body = JSON.parse(
      (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    );
    expect(body.parts).toHaveLength(2);
    // Metadata part comes first, content part second
    expect(body.parts[0].text).toMatch(/^\[meta\] /);
    expect(body.parts[0].text).toContain('"platform":"whatsapp"');
    expect(body.parts[1].text).toBe('run skill');
    // No top-level context field — metadata lives in parts only
    expect(body.context).toBeUndefined();
  });

  it('sets noReply when payload.noReply is true', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const fetchSpy = vi.fn(async () =>
      new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await triggerAgent('sess-nr', { content: 'silent', noReply: true });

    const body = JSON.parse(
      (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    );
    expect(body.noReply).toBe(true);
  });

  it('re-throws on non-OK HTTP status (caller handles retry)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const fetchSpy = vi.fn(async () =>
      new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await expect(triggerAgent('sess-err', { content: 'x' })).rejects.toThrow(/HTTP 404/);
  });

  it('re-throws on network error (caller handles retry)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await expect(triggerAgent('sess-net', { content: 'x' })).rejects.toThrow('ECONNREFUSED');
  });

  // --- getAgentSessionId ---

  it('getAgentSessionId returns the stored session id', async () => {
    const pool = mockPool([{ agent_session_id: 'sess-main-1' }]);
    const id = await getAgentSessionId(pool, 'user-1');
    expect(id).toBe('sess-main-1');
  });

  it('getAgentSessionId returns null when no row exists', async () => {
    const pool = mockPool([]);
    const id = await getAgentSessionId(pool, 'user-1');
    expect(id).toBeNull();
  });

  it('getAgentSessionId returns null when the column is null', async () => {
    const pool = mockPool([{ agent_session_id: null }]);
    const id = await getAgentSessionId(pool, 'user-1');
    expect(id).toBeNull();
  });

  // --- getAgentSessionForWorker ---

  it('getAgentSessionForWorker reads the sessionType key from the JSONB map', async () => {
    const pool = mockPool([{ agent_sessions: { 'narrative-loop': 'sess-narr-1' } }]);
    const id = await getAgentSessionForWorker(pool, 'user-1', 'narrative-loop');
    expect(id).toBe('sess-narr-1');
  });

  it('getAgentSessionForWorker returns null when the sessionType is absent', async () => {
    const pool = mockPool([{ agent_sessions: { main: 'sess-main-1' } }]);
    const id = await getAgentSessionForWorker(pool, 'user-1', 'reconcile-loop');
    expect(id).toBeNull();
  });

  it('getAgentSessionForWorker returns null when no row exists', async () => {
    const pool = mockPool([]);
    const id = await getAgentSessionForWorker(pool, 'user-1', 'narrative-loop');
    expect(id).toBeNull();
  });
});

describe('triggerAgent model selection', () => {
  beforeEach(() => {
    delete process.env.OPENCODE_MODEL_ID;
    delete process.env.OPENCODE_PROVIDER_ID;
  });

  it('includes model:{providerID,modelID} when OPENCODE_MODEL_ID is set', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    process.env.OPENCODE_MODEL_ID = 'minimax-m3';
    process.env.OPENCODE_PROVIDER_ID = 'opencode';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await triggerAgent('sess-model', { content: 'hello' });

    const body = JSON.parse((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.model).toEqual({ providerID: 'opencode', modelID: 'minimax-m3' });
  });

  it('defaults providerID to "opencode" when OPENCODE_PROVIDER_ID is unset', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    process.env.OPENCODE_MODEL_ID = 'gpt-5.4';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await triggerAgent('sess-model-default', { content: 'hello' });

    const body = JSON.parse((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.model).toEqual({ providerID: 'opencode', modelID: 'gpt-5.4' });
  });

  it('omits model field when OPENCODE_MODEL_ID is unset (back-compat)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await triggerAgent('sess-model-bc', { content: 'hello' });

    const body = JSON.parse((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.model).toBeUndefined();
  });
});
