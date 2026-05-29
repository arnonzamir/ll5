import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Mock pg so the SSE LISTEN client is a controllable fake. We capture its
// event handlers and connect/end spies to assert on cleanup.
// ---------------------------------------------------------------------------
const clientHandlers: Record<string, (arg?: unknown) => void> = {};
const clientEnd = vi.fn().mockResolvedValue(undefined);
let connectShouldFail = false;

function makeFakeClient() {
  return {
    connect: vi.fn(async () => {
      if (connectShouldFail) throw new Error('connect boom');
    }),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      clientHandlers[event] = cb;
    }),
    end: clientEnd,
  };
}

const poolMock = { query: vi.fn(), connect: vi.fn() };

vi.mock('pg', () => {
  function Client() { return makeFakeClient(); }
  function Pool() { return poolMock; }
  return { default: { Client, Pool }, Client, Pool };
});

const { createChatRouter } = await import('../chat.js');

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';

function getHandler(router: ReturnType<typeof createChatRouter>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return handlers[handlers.length - 1] as (req: Request, res: Response) => Promise<unknown>;
}

function reqAs(userId: string) {
  const closeHandlers: Array<() => void> = [];
  const r: any = {
    headers: {},
    query: {},
    body: {},
    params: {},
    userId,
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeHandlers.push(cb);
    }),
    _fireClose() { closeHandlers.forEach((c) => c()); },
  };
  return r as Request & { _fireClose: () => void };
}

function makeRes() {
  const r: any = {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };
  return r as Response & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}

describe('GET /chat/listen — SSE resource cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(clientHandlers)) delete clientHandlers[k];
    connectShouldFail = false;
    process.env.DATABASE_URL = 'postgres://x';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('on listener error: ends the PG client AND clears the keepalive interval (no leak)', async () => {
    const router = createChatRouter(poolMock as any, AUTH_SECRET);
    const handler = getHandler(router, 'get', '/listen');

    const req = reqAs('user-1');
    const res = makeRes();
    await handler(req, res);

    // keepAlive interval is now armed. Trigger the listener error path.
    expect(clientHandlers.error).toBeDefined();
    clientHandlers.error(new Error('connection dropped'));

    // The client must be closed on error.
    expect(clientEnd).toHaveBeenCalled();

    // And the keepalive timer must be cleared — advancing time must NOT write
    // another ': keepalive'. BUG: original only res.end()s, leaking the timer.
    res.write.mockClear();
    vi.advanceTimersByTime(60000);
    const keepalives = res.write.mock.calls.filter((c) => String(c[0]).includes('keepalive'));
    expect(keepalives.length).toBe(0);
  });
});
