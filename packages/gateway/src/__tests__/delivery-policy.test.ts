import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_EXPLORATION_RATE, modeCeiling, parseDeliveryPolicy, pickModality, readDeliveryPolicy, resetDeliveryPolicyCache,
} from '../utils/delivery-policy.js';
import type { DeliveryPolicy, PickInput } from '../utils/delivery-policy.js';

// DECISION-034 Phase 4 — policy pick with a seeded RNG, pure.

const NOW = new Date('2026-09-07T08:00:00Z');
const DUE_NEAR = '2026-09-07T09:00:00Z';

/** Deterministic LCG so exploration draws are reproducible. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const never = () => 0.999;
const always = () => 0.0;

function input(o: Partial<PickInput> = {}): PickInput {
  return { cls: 'needs-you', stakes: 'medium', due_at: DUE_NEAR, now: NOW, mode: 'normal', agent_level: null, policy: null, rng: never, ...o };
}

const policy: DeliveryPolicy = {
  version: 1,
  exploration_rate: 0.2,
  buckets: {
    'needs-you|medium|near|normal': { preferred: 'push_silent', floor: 'push_silent', n: 12, score: 0.8 },
    'needs-you|low|near|normal': { preferred: 'chat', floor: 'push_silent', n: 6 },
    'do-by|high|near|normal': { preferred: 'push_alert', n: 9 },
    'do-by|high|near|driving': { preferred: 'push_alert', n: 3 },
  },
};

describe('pickModality — default (no policy)', () => {
  it('is the Phase 1 stakes map when the draw does not explore', () => {
    expect(pickModality(input({ stakes: 'low' })).modality).toBe('push_silent');
    expect(pickModality(input({ stakes: 'medium' })).modality).toBe('push_notify');
    expect(pickModality(input({ stakes: 'high' })).modality).toBe('push_alert');
    const r = pickModality(input({ stakes: 'medium' }));
    expect(r).toMatchObject({ level: 'notify', explored: false, source: 'default', bucket: 'needs-you|medium|near|normal' });
  });
  it('explores one rung stronger at the default rate (0.35), never past the ceiling', () => {
    expect(DEFAULT_EXPLORATION_RATE).toBe(0.35);
    const r = pickModality(input({ stakes: 'medium', rng: always }));
    expect(r).toMatchObject({ modality: 'push_alert', level: 'alert', explored: true });
    // high stakes is already at the push_alert ceiling → nothing stronger to explore
    expect(pickModality(input({ stakes: 'high', rng: always }))).toMatchObject({ modality: 'push_alert', explored: false });
  });
  it('seeded RNG: the exploration share over many picks is about the rate', () => {
    const rng = seeded(42);
    let explored = 0;
    for (let i = 0; i < 2000; i++) if (pickModality(input({ rng })).explored) explored += 1;
    expect(explored / 2000).toBeGreaterThan(0.30);
    expect(explored / 2000).toBeLessThan(0.40);
  });
});

describe('pickModality — policy bucket', () => {
  it('uses the bucket preferred and reports source policy', () => {
    const r = pickModality(input({ policy }));
    expect(r).toMatchObject({ modality: 'push_silent', level: 'silent', explored: false, source: 'policy' });
  });
  it('never below the bucket floor', () => {
    expect(pickModality(input({ policy, stakes: 'low' })).modality).toBe('push_silent'); // preferred chat, floor push_silent
  });
  it('never below the agent level (a floor that survives the mode ceiling)', () => {
    expect(pickModality(input({ policy, agent_level: 'alert' })).modality).toBe('push_alert');
    expect(pickModality(input({ policy, agent_level: 'alert', mode: 'quiet_hours' })).modality).toBe('push_alert');
  });
  it('never above what delivery mode allows', () => {
    expect(pickModality(input({ policy, cls: 'do-by', stakes: 'high', mode: 'driving' })).modality).toBe('push_notify');
    expect(pickModality(input({ policy, cls: 'do-by', stakes: 'high', mode: 'driving', rng: always })).modality).toBe('push_notify'); // no room to explore
    expect(pickModality(input({ cls: 'do-by', stakes: 'high', mode: 'sleep' })).modality).toBe('push_silent');
    expect(modeCeiling('meeting', null)).toBe('push_notify');
    expect(modeCeiling('sleep', 'critical')).toBe('push_alarm');
  });
  it('explores at the policy rate, one rung stronger than the bucket preferred', () => {
    const r = pickModality(input({ policy, rng: () => 0.1 }));  // 0.1 < 0.2
    expect(r).toMatchObject({ modality: 'push_notify', explored: true });
    expect(pickModality(input({ policy, rng: () => 0.25 })).explored).toBe(false);
  });
});

describe('parseDeliveryPolicy', () => {
  it('accepts an object or a JSON string and drops malformed buckets', () => {
    const p = parseDeliveryPolicy(JSON.stringify({
      version: 2, updated_at: '2026-09-21', exploration_rate: 1.7,
      buckets: { ok: { preferred: 'push_alert', floor: 'push_silent', n: 4 }, bad: { preferred: 'loud' }, worse: 'x' },
    }))!;
    expect(p.version).toBe(2);
    expect(p.exploration_rate).toBe(1);
    expect(Object.keys(p.buckets)).toEqual(['ok']);
    expect(parseDeliveryPolicy(null)).toBeNull();
    expect(parseDeliveryPolicy('not json')).toBeNull();
    expect(parseDeliveryPolicy({ version: 1 })).toBeNull();
    expect(parseDeliveryPolicy({ buckets: {} })!.exploration_rate).toBeUndefined();
  });
  it('a section over 12 KB is refused', () => {
    expect(parseDeliveryPolicy('x'.repeat(12 * 1024 + 1))).toBeNull();
  });
});

describe('readDeliveryPolicy — 5-minute cache, failure = no policy', () => {
  beforeEach(() => resetDeliveryPolicyCache());
  const cfg = { awarenessMcpUrl: 'http://awareness.test', authSecret: 's' };

  it('caches per user for 5 minutes', async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; return { buckets: { k: { preferred: 'chat' } } }; };
    const t0 = Date.parse('2026-09-07T08:00:00Z');
    expect((await readDeliveryPolicy(cfg, 'u1', fetcher, t0))!.buckets.k.preferred).toBe('chat');
    await readDeliveryPolicy(cfg, 'u1', fetcher, t0 + 4 * 60_000);
    expect(calls).toBe(1);
    await readDeliveryPolicy(cfg, 'u1', fetcher, t0 + 6 * 60_000);
    expect(calls).toBe(2);
    await readDeliveryPolicy(cfg, 'u2', fetcher, t0);
    expect(calls).toBe(3);
  });

  it('a throwing fetcher yields null (Phase 1 map applies) and is cached too', async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; throw new Error('mcp down'); };
    expect(await readDeliveryPolicy(cfg, 'u1', fetcher, 0)).toBeNull();
    expect(await readDeliveryPolicy(cfg, 'u1', fetcher, 1000)).toBeNull();
    expect(calls).toBe(1);
  });
});
