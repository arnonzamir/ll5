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
