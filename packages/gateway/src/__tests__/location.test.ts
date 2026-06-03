import { describe, it, expect } from 'vitest';
import { phraseArrival } from '../processors/location.js';

// Note: the semantic-label derivation that `deriveLabel` used to own now lives in
// the shared canonical resolver (`@ll5/shared` `resolveLocation`) and is covered
// by packages/shared/src/__tests__/location-resolve.test.ts (fusion tiers, wifi
// anchoring, departure hysteresis). The gateway keeps only the push-wording here.

describe('phraseArrival — user-facing push body', () => {
  it('special-cases home', () => {
    expect(phraseArrival({ label: 'Home', kind: 'place' })).toBe("You're home");
    expect(phraseArrival({ label: 'home', kind: 'place' })).toBe("You're home");
  });

  it('uses "at" for other known places', () => {
    expect(phraseArrival({ label: 'Office', kind: 'place' })).toBe("You're at Office");
  });

  it('uses "in" for cities/towns', () => {
    expect(phraseArrival({ label: "Be'erotaim", kind: 'city' })).toBe("You're in Be'erotaim");
  });
});
