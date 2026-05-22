import { describe, it, expect } from 'vitest';
import { deriveLabel, phraseArrival } from '../processors/location.js';

describe('deriveLabel — current semantic location label', () => {
  it('prefers a matched known place over city', () => {
    const r = deriveLabel(
      { place_id: 'p1', place_name: 'Home' },
      { address: 'x', city: 'Zikhron Yaakov' },
    );
    expect(r).toEqual({ label: 'Home', kind: 'place', place_id: 'p1', city: 'Zikhron Yaakov' });
  });

  it('falls back to city/town when no known place matches', () => {
    const r = deriveLabel(null, { address: 'x', city: "Be'erotaim" });
    expect(r).toEqual({ label: "Be'erotaim", kind: 'city', city: "Be'erotaim" });
  });

  it('returns null when neither place nor city is known (in transit)', () => {
    expect(deriveLabel(null, { address: 'middle of a highway' })).toBeNull();
    expect(deriveLabel(null, null)).toBeNull();
  });
});

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
