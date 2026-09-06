import { describe, it, expect } from 'vitest';
import type { ConnectorEventInput } from '@ll5/shared';
import { evaluate, merchantKey, normalizeThresholds, DEFAULT_RULE_THRESHOLDS, type RuleContext, type RuleId } from '../connectors/rules.js';
import { MerchantMemory } from '../connectors/merchant-memory.js';
import { parseConnectorSettings } from '../connectors/settings.js';

const T0 = '2026-09-06T12:31:00+03:00';

function ev(over: Partial<ConnectorEventInput> = {}): ConnectorEventInput {
  return {
    connector_id: 'cal', kind: 'charge', occurred_at: T0, amount: 214, currency: 'ILS', foreign: false,
    merchant: 'SUPER PHARM', account_ref: '4321', dedupe_key: 'k', payload: {}, ...over,
  };
}
function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    thresholds: { ...DEFAULT_RULE_THRESHOLDS },
    knownMerchantKeys: new Set(['super pharm']),
    recentEvents: [],
    deliveryMode: 'normal',
    atHome: false,
    ...over,
  };
}
const rules = (e: ConnectorEventInput, c: RuleContext): RuleId[] => evaluate(e, c).map((h) => h.rule);

describe('connector rules — table', () => {
  const cases: Array<{ name: string; event: ConnectorEventInput; ctx: RuleContext; expect: RuleId[] }> = [
    { name: 'known merchant, small, local, awake → nothing', event: ev(), ctx: ctx(), expect: [] },
    { name: 'amount at threshold trips amount_threshold', event: ev({ amount: 500 }), ctx: ctx(), expect: ['amount_threshold'] },
    { name: 'amount just under threshold does not', event: ev({ amount: 499.99 }), ctx: ctx(), expect: [] },
    { name: 'custom threshold from settings', event: ev({ amount: 150 }), ctx: ctx({ thresholds: { amount_threshold: 100, duplicate_window_minutes: 10 } }), expect: ['amount_threshold'] },
    { name: 'merchant not in known set → unknown_merchant', event: ev({ merchant: 'NEW SHOP' }), ctx: ctx(), expect: ['unknown_merchant'] },
    { name: 'merchant key match is case/punctuation-insensitive', event: ev({ merchant: 'Super-Pharm!' }), ctx: ctx(), expect: [] },
    { name: 'no merchant text → cannot judge, no unknown_merchant', event: ev({ merchant: null }), ctx: ctx(), expect: [] },
    { name: 'foreign flag → foreign', event: ev({ foreign: true, currency: 'USD', amount: 12.99 }), ctx: ctx(), expect: ['foreign'] },
    { name: 'same amount+merchant 5 min earlier → duplicate', event: ev(), ctx: ctx({ recentEvents: [{ merchantKey: 'super pharm', amount: 214, currency: 'ILS', occurred_at: '2026-09-06T12:26:00+03:00' }] }), expect: ['duplicate'] },
    { name: 'same amount+merchant 11 min earlier → not a duplicate (window 10)', event: ev(), ctx: ctx({ recentEvents: [{ merchantKey: 'super pharm', amount: 214, currency: 'ILS', occurred_at: '2026-09-06T12:20:00+03:00' }] }), expect: [] },
    { name: 'same amount, other merchant → not a duplicate', event: ev(), ctx: ctx({ recentEvents: [{ merchantKey: 'rami levy', amount: 214, currency: 'ILS', occurred_at: '2026-09-06T12:30:00+03:00' }] }), expect: [] },
    { name: 'same merchant, other amount → not a duplicate', event: ev(), ctx: ctx({ recentEvents: [{ merchantKey: 'super pharm', amount: 215, currency: 'ILS', occurred_at: '2026-09-06T12:30:00+03:00' }] }), expect: [] },
    { name: 'same amount, other currency → not a duplicate', event: ev(), ctx: ctx({ recentEvents: [{ merchantKey: 'super pharm', amount: 214, currency: 'USD', occurred_at: '2026-09-06T12:30:00+03:00' }] }), expect: [] },
    { name: 'sleep mode at home → asleep_at_home', event: ev(), ctx: ctx({ deliveryMode: 'sleep', atHome: true }), expect: ['asleep_at_home'] },
    { name: 'sleep mode away from home → nothing (could be a travel night)', event: ev(), ctx: ctx({ deliveryMode: 'sleep', atHome: false }), expect: [] },
    { name: 'quiet hours at home is not sleep', event: ev(), ctx: ctx({ deliveryMode: 'quiet_hours', atHome: true }), expect: [] },
    { name: 'several rules stack in a fixed order', event: ev({ amount: 900, merchant: 'CASINO ONLINE', foreign: true, currency: 'EUR' }), ctx: ctx({ deliveryMode: 'sleep', atHome: true }), expect: ['amount_threshold', 'unknown_merchant', 'foreign', 'asleep_at_home'] },
    { name: 'refund never trips', event: ev({ kind: 'refund', amount: 9999, merchant: 'X', foreign: true }), ctx: ctx({ deliveryMode: 'sleep', atHome: true }), expect: [] },
    { name: 'bill never trips', event: ev({ kind: 'bill', amount: 9999 }), ctx: ctx(), expect: [] },
    { name: 'otp never trips', event: ev({ kind: 'otp', amount: null }), ctx: ctx({ deliveryMode: 'sleep', atHome: true }), expect: [] },
    { name: 'unknown never trips', event: ev({ kind: 'unknown', amount: null, merchant: null }), ctx: ctx(), expect: [] },
    { name: 'charge with null amount: threshold/duplicate skipped, merchant still judged', event: ev({ amount: null, merchant: 'NEW SHOP' }), ctx: ctx(), expect: ['unknown_merchant'] },
  ];
  for (const c of cases) {
    it(c.name, () => expect(rules(c.event, c.ctx)).toEqual(c.expect));
  }

  it('hits carry a human detail for the system message', () => {
    const hits = evaluate(ev({ merchant: 'NEW SHOP', amount: 600 }), ctx());
    expect(hits.map((h) => h.detail)).toEqual(['over 500', 'unknown merchant']);
  });
});

describe('merchantKey', () => {
  it('lowercases, keeps Hebrew/Latin letters and digits, collapses punctuation', () => {
    expect(merchantKey('SUPER-PHARM')).toBe('super pharm');
    expect(merchantKey('נכסי הר חוטבים בע"מ')).toBe('נכסי הר חוטבים בע מ');
    expect(merchantKey('GOOGLE *TEMPORARY HOLD')).toBe('google');
    expect(merchantKey('')).toBeNull();
    expect(merchantKey(null)).toBeNull();
    expect(merchantKey('***')).toBeNull();
  });
});

describe('thresholds and settings', () => {
  it('normalizeThresholds fills defaults and rejects bad values', () => {
    expect(normalizeThresholds(undefined)).toEqual(DEFAULT_RULE_THRESHOLDS);
    expect(normalizeThresholds({ amount_threshold: 1000 })).toEqual({ amount_threshold: 1000, duplicate_window_minutes: 10 });
    expect(normalizeThresholds({ amount_threshold: '1000', duplicate_window_minutes: -1 })).toEqual(DEFAULT_RULE_THRESHOLDS);
  });
  it('parseConnectorSettings reads rules + known_merchants as keys', () => {
    const s = parseConnectorSettings({ rules: { amount_threshold: 300 }, known_merchants: ['Super-Pharm', 'רמי לוי', 7, ''] });
    expect(s.thresholds).toEqual({ amount_threshold: 300, duplicate_window_minutes: 10 });
    expect([...s.knownMerchantKeys]).toEqual(['super pharm', 'רמי לוי']);
  });
});

describe('MerchantMemory', () => {
  it('a merchant is known after two sightings inside the window', () => {
    const m = new MerchantMemory();
    const now = Date.parse(T0);
    expect(m.isKnown('u', 'super pharm', now)).toBe(false);
    m.note('u', 'super pharm', now);
    expect(m.isKnown('u', 'super pharm', now)).toBe(false);
    m.note('u', 'super pharm', now + 1000);
    expect(m.isKnown('u', 'super pharm', now + 2000)).toBe(true);
    expect([...m.knownKeys('u', now + 2000)]).toEqual(['super pharm']);
  });
  it('forgets after the 90-day window and evicts LRU past the cap', () => {
    const m = new MerchantMemory({ maxKeysPerUser: 2, windowMs: 1000 });
    m.note('u', 'a', 0); m.note('u', 'a', 1);
    expect(m.isKnown('u', 'a', 500)).toBe(true);
    expect(m.isKnown('u', 'a', 5000)).toBe(false);
    m.note('u', 'b', 10); m.note('u', 'c', 20);
    expect(m.size('u')).toBe(2);
    expect(m.isKnown('u', 'a', 20)).toBe(false); // evicted
  });
  it('is per user', () => {
    const m = new MerchantMemory();
    m.note('u1', 'x', 0); m.note('u1', 'x', 1);
    expect(m.isKnown('u1', 'x', 2)).toBe(true);
    expect(m.isKnown('u2', 'x', 2)).toBe(false);
  });
});
