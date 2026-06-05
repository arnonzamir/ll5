import { describe, it, expect } from 'vitest';
import {
  resolveLocation,
  gateAccuracy,
  detectDriftGlitch,
  haversineMeters,
} from '../location/index.js';
import type { GpsSignal, WifiSignal } from '../location/index.js';

const HOME = { placeId: 'home-uuid', placeName: 'Home' };
const homeWifi = (over: Partial<WifiSignal> = {}): WifiSignal => ({
  bssid: '50:0f:f5:26:70:f2',
  ssid: 'shrimp3',
  connected: true,
  ageMs: 60_000,
  bssidPlace: { ...HOME, confident: true },
  ...over,
});
const gps = (over: Partial<GpsSignal> = {}): GpsSignal => ({
  lat: 32.57, lon: 34.955, accuracyM: 30, ageMs: 60_000, matchedPlace: HOME, city: 'Zikhron Yaakov',
  ...over,
});

describe('resolveLocation — fusion tiers', () => {
  it('tier 1: fresh GPS at place + wifi agrees → high gps+wifi', () => {
    const r = resolveLocation({ gps: gps(), wifi: homeWifi() });
    expect(r).toMatchObject({ place: 'Home', source: 'gps+wifi', confidence: 'high', labelKind: 'place' });
  });

  it('tier 2: fresh GPS at place, no wifi → high gps, placeId populated', () => {
    const r = resolveLocation({ gps: gps(), wifi: null });
    expect(r).toMatchObject({ place: 'Home', placeId: 'home-uuid', source: 'gps', confidence: 'high' });
  });

  it('tier 4 (THE FIX): fresh GPS drifted off home radius but on home wifi → Home', () => {
    const r = resolveLocation({ gps: gps({ matchedPlace: null }), wifi: homeWifi() });
    expect(r).toMatchObject({ place: 'Home', labelKind: 'place', source: 'gps+wifi' });
  });

  it('tier 5: fresh GPS, no place, no wifi → city-level label, place null', () => {
    const r = resolveLocation({ gps: gps({ matchedPlace: null }), wifi: null });
    expect(r.place).toBeNull();
    expect(r).toMatchObject({ label: 'Zikhron Yaakov', labelKind: 'city' });
  });

  it('non-confident wifi does NOT anchor', () => {
    const r = resolveLocation({
      gps: gps({ matchedPlace: null }),
      wifi: homeWifi({ bssidPlace: { ...HOME, confident: false } }),
    });
    expect(r.labelKind).toBe('city'); // falls through to city, not Home
  });

  it('REGRESSION: a CONNECTED wifi event up to 2h old still anchors (sparse heartbeats)', () => {
    // The night-flap bug: latest "connected to home" event was 20-57 min old and
    // the old 10-min window treated it as stale → no anchor → flap.
    const r = resolveLocation({
      gps: gps({ matchedPlace: null }),
      wifi: homeWifi({ ageMs: 40 * 60 * 1000 }),
    });
    expect(r).toMatchObject({ place: 'Home', labelKind: 'place' });
  });

  it('a CONNECTED wifi event older than 2h no longer anchors', () => {
    const r = resolveLocation({
      gps: gps({ matchedPlace: null }),
      wifi: homeWifi({ ageMs: 3 * 60 * 60 * 1000 }),
    });
    expect(r.labelKind).toBe('city');
  });

  it('tier 7: nothing → unknown/none', () => {
    const r = resolveLocation({ gps: null, wifi: null });
    expect(r).toMatchObject({ place: null, source: 'none', confidence: 'unknown', label: null });
  });
});

describe('resolveLocation — departure hysteresis (write path)', () => {
  const prior = { label: 'Home', kind: 'place' as const, placeId: 'home-uuid' };

  it('HOLDS Home on a low-accuracy fresh fix that lost the place match', () => {
    const r = resolveLocation({ gps: gps({ matchedPlace: null, accuracyM: 140 }), wifi: null, prior });
    expect(r).toMatchObject({ place: 'Home', label: 'Home', labelKind: 'place', source: 'hold' });
  });

  it('REGRESSION: HOLDS Home on a ~100m-accuracy edge fix (the home jitter)', () => {
    // accuracy ~= the 100m radius can't tell inside from outside → must not release.
    const r = resolveLocation({ gps: gps({ matchedPlace: null, accuracyM: 100 }), wifi: null, prior });
    expect(r).toMatchObject({ label: 'Home', labelKind: 'place', source: 'hold' });
  });

  it('HOLDS Home on a stale fix', () => {
    const r = resolveLocation({ gps: gps({ matchedPlace: null, ageMs: 12 * 60 * 1000 }), wifi: null, prior });
    expect(r.source).toBe('hold');
    expect(r.labelKind).toBe('place');
  });

  it('RELEASES to city on a fresh, good-accuracy fix with no place (real departure)', () => {
    const r = resolveLocation({ gps: gps({ matchedPlace: null, accuracyM: 25 }), wifi: null, prior });
    expect(r).toMatchObject({ label: 'Zikhron Yaakov', labelKind: 'city' });
    expect(r.source).not.toBe('hold');
  });

  it('no hold when prior is a city (only places get held)', () => {
    const r = resolveLocation({
      gps: gps({ matchedPlace: null, accuracyM: 140 }), wifi: null,
      prior: { label: 'Zikhron Yaakov', kind: 'city' },
    });
    expect(r.source).not.toBe('hold');
  });
});

describe('resolveLocation — recently_left', () => {
  it('sets recently_left on stale GPS + recent confident wifi disconnect', () => {
    const r = resolveLocation({
      gps: gps({ matchedPlace: null, ageMs: 12 * 60 * 1000 }),
      wifi: homeWifi({ connected: false, ageMs: 90_000 }),
    });
    expect(r.recentlyLeft).toMatchObject({ placeName: 'Home', placeId: 'home-uuid' });
  });
});

describe('gateAccuracy', () => {
  it('drops garbage (>2000m)', () => expect(gateAccuracy(2500)).toEqual({ drop: true, lowAccuracy: false }));
  it('flags low (>100m)', () => expect(gateAccuracy(150)).toEqual({ drop: false, lowAccuracy: true }));
  it('keeps good (<=100m)', () => expect(gateAccuracy(40)).toEqual({ drop: false, lowAccuracy: false }));
  it('keeps when accuracy unknown', () => expect(gateAccuracy(null)).toEqual({ drop: false, lowAccuracy: false }));
});

describe('detectDriftGlitch', () => {
  const t0 = 1_000_000_000_000;
  const prev = { lat: 32.57, lon: 34.955, timestampMs: t0, atKnownPlace: true };

  it('drops a teleport over the absolute ceiling', () => {
    // ~500 km in 1 minute
    const v = detectDriftGlitch({ ...prev, atKnownPlace: false }, { lat: 36.5, lon: 34.955, timestampMs: t0 + 60_000 });
    expect(v.drop).toBe(true);
  });

  it('drops implausible jump with no device speed', () => {
    // ~5 km in 1 min = 300 km/h, no device speed
    const v = detectDriftGlitch({ ...prev, atKnownPlace: false }, { lat: 32.615, lon: 34.955, timestampMs: t0 + 60_000 });
    expect(v.drop).toBe(true);
  });

  it('keeps fast travel confirmed by device speed', () => {
    const v = detectDriftGlitch({ ...prev, atKnownPlace: false }, { lat: 32.615, lon: 34.955, timestampMs: t0 + 60_000 }, 280);
    expect(v.drop).toBe(false);
  });

  it('drops stationary jitter near a known place', () => {
    // 0.7 km in 2 min, device stationary, prev at known place
    const v = detectDriftGlitch(prev, { lat: 32.576, lon: 34.955, timestampMs: t0 + 120_000 }, 0);
    expect(v.drop).toBe(true);
  });

  it('does not drop when there is no predecessor', () => {
    expect(detectDriftGlitch(null, { lat: 32.57, lon: 34.955, timestampMs: t0 }).drop).toBe(false);
  });
});

describe('haversineMeters', () => {
  it('~111km per degree latitude', () => {
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeGreaterThan(110_000);
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeLessThan(112_000);
  });
});

import { cardinal, motionState, describeLocation } from '../location/index.js';

describe('cardinal direction', () => {
  it('maps degrees to 8-point cardinals', () => {
    expect(cardinal(0)).toBe('north');
    expect(cardinal(90)).toBe('east');
    expect(cardinal(180)).toBe('south');
    expect(cardinal(270)).toBe('west');
    expect(cardinal(45)).toBe('northeast');
    expect(cardinal(350)).toBe('north');
    expect(cardinal(-90)).toBe('west');
  });
});

describe('motionState', () => {
  it('classifies from speed', () => {
    expect(motionState(undefined)).toBe('unknown');
    expect(motionState(0)).toBe('stationary');
    expect(motionState(3)).toBe('walking');
    expect(motionState(25)).toBe('driving');
  });
});

describe('describeLocation — useful descriptions', () => {
  const g = (over: Partial<GpsSignal>): GpsSignal => ({ lat: 32.1, lon: 34.8, ageMs: 1000, ...over });

  it('known place is its own description', () => {
    expect(describeLocation(g({ speedMps: 25 }), 'Home').description).toBe('Home');
  });
  it('driving → on road, heading cardinal, near city', () => {
    const r = describeLocation(g({ speedMps: 25, road: 'Route 6', bearingDeg: 180, city: 'Kfar Saba' }), null);
    expect(r.motion).toBe('driving');
    expect(r.description).toBe('driving on Route 6, heading south — near Kfar Saba');
  });
  it('driving without a road still gives direction + city', () => {
    expect(describeLocation(g({ speedMps: 25, bearingDeg: 0, city: 'Hadera' }), null).description)
      .toBe('driving heading north — near Hadera');
  });
  it('stationary unknown spot → near street, city', () => {
    const r = describeLocation(g({ speedMps: 0, road: 'Masada St', neighborhood: 'Hadar', city: 'Haifa' }), null);
    expect(r.motion).toBe('stationary');
    expect(r.description).toBe('near Masada St, Haifa');
  });
  it('falls back to neighborhood then city', () => {
    expect(describeLocation(g({ speedMps: 0, neighborhood: 'Hadar', city: 'Haifa' }), null).description)
      .toBe('near Hadar, Haifa');
    expect(describeLocation(g({ speedMps: 0, city: 'Haifa' }), null).description).toBe('near Haifa');
  });

  it('resolveLocation attaches description + motion (driving, no place)', () => {
    const r = resolveLocation({ gps: { lat: 32, lon: 34, ageMs: 1000, matchedPlace: null, city: 'Hadera', road: 'Route 2', bearingDeg: 200, speedMps: 30 } });
    expect(r.motion).toBe('driving');
    expect(r.description).toContain('on Route 2');
    expect(r.description).toContain('heading');
  });
});
