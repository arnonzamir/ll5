import { describe, it, expect } from 'vitest';
import { registrableDomain, sameRegistrableDomain, isDomainApproved, itemDomains } from '../domain.js';

describe('domain binding (DECISION-022 hard rule #1)', () => {
  describe('registrableDomain', () => {
    it('extracts eTLD+1 from URLs', () => {
      expect(registrableDomain('https://portal.example.com/login')).toBe('example.com');
      expect(registrableDomain('https://www.school-portal.co.il/auth?x=1')).toBe('school-portal.co.il');
      expect(registrableDomain('http://a.b.c.example.org:8443/x')).toBe('example.org');
    });

    it('handles bare hostnames and normalizes case', () => {
      expect(registrableDomain('Portal.Example.COM')).toBe('example.com');
      expect(registrableDomain('example.com')).toBe('example.com');
    });

    it('fails closed on IPs, localhost, and garbage', () => {
      expect(registrableDomain('http://192.168.1.1/login')).toBeNull();
      expect(registrableDomain('http://localhost:3000')).toBeNull();
      expect(registrableDomain('')).toBeNull();
      expect(registrableDomain('not a url at all //')).toBeNull();
    });
  });

  describe('sameRegistrableDomain', () => {
    it('matches subdomains of the same registrable domain', () => {
      expect(sameRegistrableDomain('https://example.com/login', 'https://auth.example.com/session')).toBe(true);
    });

    it('rejects different registrable domains — the phishing case', () => {
      // Lookalike domain must NOT match.
      expect(sameRegistrableDomain('https://example.com/login', 'https://example.com.evil.net/login')).toBe(false);
      expect(sameRegistrableDomain('https://bank.co.il', 'https://bank.co')).toBe(false);
    });

    it('rejects same-suffix-different-name (public suffix aware)', () => {
      // co.il is a public suffix — two names under it are DIFFERENT domains.
      expect(sameRegistrableDomain('https://a.co.il', 'https://b.co.il')).toBe(false);
    });

    it('fails closed when either side is unresolvable', () => {
      expect(sameRegistrableDomain('https://example.com', 'http://10.0.0.1')).toBe(false);
      expect(sameRegistrableDomain('', 'https://example.com')).toBe(false);
    });
  });

  describe('isDomainApproved (allowlist)', () => {
    it('approves exact registrable-domain matches, normalizing entries', () => {
      expect(isDomainApproved('example.com', ['example.com'])).toBe(true);
      expect(isDomainApproved('example.com', ['https://www.example.com/login'])).toBe(true);
      expect(isDomainApproved('sub.example.com', ['example.com'])).toBe(true);
    });

    it('rejects unlisted domains and lookalikes', () => {
      expect(isDomainApproved('example.com', ['other.com'])).toBe(false);
      expect(isDomainApproved('example.com.evil.net', ['example.com'])).toBe(false);
      expect(isDomainApproved('example.com', [])).toBe(false);
    });

    it('fails closed on malformed input', () => {
      expect(isDomainApproved('example.com', 'example.com' as unknown as string[])).toBe(false);
      expect(isDomainApproved('example.com', [42, null, {}] as unknown as string[])).toBe(false);
      expect(isDomainApproved('', ['example.com'])).toBe(false);
    });
  });

  describe('itemDomains', () => {
    it('lists unique registrable domains from item uris', () => {
      expect(itemDomains([
        { uri: 'https://portal.example.com/login' },
        { uri: 'https://example.com' },
        { uri: 'https://other.org/x' },
        { uri: null },
      ])).toEqual(['example.com', 'other.org']);
    });

    it('handles missing uris', () => {
      expect(itemDomains(undefined)).toEqual([]);
      expect(itemDomains([])).toEqual([]);
    });
  });
});
