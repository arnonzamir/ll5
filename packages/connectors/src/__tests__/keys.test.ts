import { describe, it, expect } from 'vitest';
import { normalizeMerchant, merchantKey, merchantSubKey, dedupeKey } from '../utils/keys.js';

const KEY = 'c'.repeat(64);
const SUB = merchantSubKey(KEY);

describe('merchant_key helpers', () => {
  it('normalizes case, punctuation, width and whitespace', () => {
    expect(normalizeMerchant('  SUPER-PHARM   TLV ')).toBe('super pharm tlv');
    expect(normalizeMerchant('Ｗｏｌｔ')).toBe('wolt');
    expect(normalizeMerchant('סופר פארם*123')).toBe('סופר פארם 123');
    expect(normalizeMerchant(null)).toBe('');
    expect(normalizeMerchant('***')).toBe('');
  });

  it('hashes the same business the same way across notification and ledger spellings', () => {
    const a = merchantKey('SUPER-PHARM TLV', SUB);
    const b = merchantKey('super pharm, tlv', SUB);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(merchantKey('wolt', SUB)).not.toBe(a);
  });

  it('is keyed: a different service key gives a different merchant_key; no merchant gives null', () => {
    expect(merchantKey('wolt', merchantSubKey('d'.repeat(64)))).not.toBe(merchantKey('wolt', SUB));
    expect(merchantKey('', SUB)).toBeNull();
    expect(merchantKey(undefined, SUB)).toBeNull();
  });

  it('the sub-key is derived, not the AES key itself', () => {
    expect(SUB).not.toBe(KEY);
    expect(SUB).toHaveLength(64);
  });
});

describe('dedupe_key', () => {
  it('is stable over the same parts and sensitive to any part', () => {
    const k = dedupeKey(['cal', 'com.onoapps.cal4u', 1757150000000, 'title', 'text']);
    expect(k).toBe(dedupeKey(['cal', 'com.onoapps.cal4u', 1757150000000, 'title', 'text']));
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(dedupeKey(['cal', 'com.onoapps.cal4u', 1757150000001, 'title', 'text'])).not.toBe(k);
    expect(dedupeKey(['cal', 'com.onoapps.cal4u', 1757150000000, 'title', 'text 214'])).not.toBe(k);
  });

  it('treats null and undefined parts as empty strings', () => {
    expect(dedupeKey(['a', null, 'b'])).toBe(dedupeKey(['a', undefined, 'b']));
    expect(dedupeKey(['a', null, 'b'])).toBe(dedupeKey(['a', '', 'b']));
  });
});
