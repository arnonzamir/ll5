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

  it('DRIVE-PAST FIX: a place match while DRIVING is a fly-by → city-level, not "at place"', () => {
    // Fresh GPS within the place radius (matchedPlace=Home) but moving at driving
    // speed — you're driving past, not visiting. Must NOT label you "at Home".
    const r = resolveLocation({ gps: gps({ speedMps: 15 }), wifi: null });
    expect(r.place).toBeNull();
    expect(r).toMatchObject({ label: 'Zikhron Yaakov', labelKind: 'city' });
  });

  it('a SLOW fix within the place radius still resolves to the place (a real visit)', () => {
    const r = resolveLocation({ gps: gps({ speedMps: 0.5 }), wifi: null });
    expect(r).toMatchObject({ place: 'Home', labelKind: 'place' });
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

describe('resolveLocation — visible-fingerprint tier (DECISION-021)', () => {
  const visible = (
    networks: Array<{ rssi: number; place?: typeof HOME; confident?: boolean; bssid?: string }>,
    ageMs = 120_000,
  ) => ({
    ageMs,
    networks: networks.map((n, i) => ({
      bssid: n.bssid ?? `aa:bb:cc:dd:ee:0${i}`,
      ssid: `net-${i}`,
      rssi: n.rssi,
      place: { ...(n.place ?? HOME), confident: n.confident ?? true },
    })),
  });

  it('ANCHORS when GPS is absent: two same-place visible networks → place, medium, wifi_scan', () => {
    const r = resolveLocation({
      gps: null, wifi: null,
      visibleKnown: visible([{ rssi: -70 }, { rssi: -72 }]),
    });
    expect(r).toMatchObject({
      place: 'Home', placeId: 'home-uuid', confidence: 'medium', source: 'wifi_scan', labelKind: 'place',
    });
    expect(r.reasoning).toContain('approximate');
  });

  it('ANCHORS when GPS is stale', () => {
    const r = resolveLocation({
      gps: gps({ matchedPlace: null, ageMs: 12 * 60 * 1000 }), wifi: null,
      visibleKnown: visible([{ rssi: -70 }, { rssi: -72 }]),
    });
    expect(r).toMatchObject({ place: 'Home', source: 'wifi_scan' });
  });

  it('ANCHORS when fresh GPS is COARSE (accuracy > 100m) with no place match', () => {
    const r = resolveLocation({
      gps: gps({ matchedPlace: null, accuracyM: 350 }), wifi: null,
      visibleKnown: visible([{ rssi: -70 }, { rssi: -72 }]),
    });
    expect(r).toMatchObject({ place: 'Home', source: 'wifi_scan', confidence: 'medium' });
  });

  it('one STRONG network (rssi >= -65) is enough on its own', () => {
    const r = resolveLocation({ gps: null, wifi: null, visibleKnown: visible([{ rssi: -60 }]) });
    expect(r).toMatchObject({ place: 'Home', source: 'wifi_scan' });
  });

  it('one WEAK network (< -65) is NOT enough — needs 2 same-place matches', () => {
    const r = resolveLocation({ gps: null, wifi: null, visibleKnown: visible([{ rssi: -70 }]) });
    expect(r).toMatchObject({ place: null, source: 'none' });
  });

  it('two weak networks at DIFFERENT places do not elect either', () => {
    const OFFICE = { placeId: 'office-uuid', placeName: 'Office' };
    const r = resolveLocation({
      gps: null, wifi: null,
      visibleKnown: visible([{ rssi: -70, place: HOME }, { rssi: -71, place: OFFICE }]),
    });
    expect(r.place).toBeNull();
  });

  it('STALE scan (> 10 min) is ignored entirely', () => {
    const r = resolveLocation({
      gps: null, wifi: null,
      visibleKnown: visible([{ rssi: -55 }, { rssi: -60 }], 11 * 60 * 1000),
    });
    expect(r).toMatchObject({ place: null, source: 'none' });
  });

  it('non-confident bindings never vote', () => {
    const r = resolveLocation({
      gps: null, wifi: null,
      visibleKnown: visible([{ rssi: -55, confident: false }, { rssi: -60, confident: false }]),
    });
    expect(r.place).toBeNull();
  });

  it('CORROBORATES a fresh GPS place match (stays high, reasoning notes the fingerprint)', () => {
    const r = resolveLocation({
      gps: gps(), wifi: null,
      visibleKnown: visible([{ rssi: -60 }, { rssi: -70 }]),
    });
    expect(r).toMatchObject({ place: 'Home', confidence: 'high', source: 'gps' });
    expect(r.reasoning).toContain('corroborates');
  });

  it('GPS WINS on disagreement: fresh precise fix with no place match → city, not the scan place', () => {
    // Drive-past protection: a clean fix says you are NOT at Home even though
    // Home\'s fingerprint is still visible from the road.
    const r = resolveLocation({
      gps: gps({ matchedPlace: null, accuracyM: 25 }), wifi: null,
      visibleKnown: visible([{ rssi: -60 }, { rssi: -70 }]),
    });
    expect(r.place).toBeNull();
    expect(r).toMatchObject({ label: 'Zikhron Yaakov', labelKind: 'city' });
  });

  it('GPS WINS on disagreement: fresh fix matched to a DIFFERENT place beats the scan', () => {
    const OFFICE = { placeId: 'office-uuid', placeName: 'Office' };
    const r = resolveLocation({
      gps: gps({ matchedPlace: OFFICE }), wifi: null,
      visibleKnown: visible([{ rssi: -60 }, { rssi: -70 }]),
    });
    expect(r).toMatchObject({ place: 'Office', confidence: 'high' });
  });

  it('the CONNECTED-wifi anchor outranks the scan tier', () => {
    const OFFICE = { placeId: 'office-uuid', placeName: 'Office' };
    const r = resolveLocation({
      gps: null,
      wifi: homeWifi(),
      visibleKnown: visible([{ rssi: -55, place: OFFICE }, { rssi: -60, place: OFFICE }]),
    });
    expect(r).toMatchObject({ place: 'Home', source: 'wifi' });
  });

  it('stale-usable GPS at the same place: scan anchors and notes the agreement', () => {
    const r = resolveLocation({
      gps: gps({ ageMs: 12 * 60 * 1000 }), wifi: null,
      visibleKnown: visible([{ rssi: -70 }, { rssi: -72 }]),
    });
    expect(r).toMatchObject({ place: 'Home', confidence: 'medium', source: 'wifi_scan' });
    expect(r.reasoning).toContain('stale GPS agrees');
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

import { cardinal, motionState, describeLocation, freshnessLabel, precisionLabel, speedKmh } from '../location/index.js';
import { GPS_FRESH_MS, GPS_STALE_USABLE_MS, WIFI_CONNECTED_ANCHOR_MS } from '../location/index.js';

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

describe('freshnessLabel — GPS-fix age buckets', () => {
  it('maps age to live/recent/stale/unknown', () => {
    expect(freshnessLabel(0)).toBe('live');
    expect(freshnessLabel(GPS_FRESH_MS - 1)).toBe('live');
    expect(freshnessLabel(GPS_FRESH_MS)).toBe('recent');
    expect(freshnessLabel(GPS_STALE_USABLE_MS - 1)).toBe('recent');
    expect(freshnessLabel(GPS_STALE_USABLE_MS)).toBe('stale');
    expect(freshnessLabel(WIFI_CONNECTED_ANCHOR_MS - 1)).toBe('stale');
    expect(freshnessLabel(WIFI_CONNECTED_ANCHOR_MS)).toBe('unknown');
  });
});

describe('precisionLabel — accuracy buckets', () => {
  it('buckets accuracy radius (m) into high/approximate/coarse/unknown', () => {
    expect(precisionLabel(null)).toBe('unknown');
    expect(precisionLabel(undefined)).toBe('unknown');
    expect(precisionLabel(10)).toBe('high');
    expect(precisionLabel(30)).toBe('high');
    expect(precisionLabel(31)).toBe('approximate');
    expect(precisionLabel(100)).toBe('approximate');
    expect(precisionLabel(101)).toBe('coarse');
    expect(precisionLabel(1500)).toBe('coarse');
  });
});

describe('speedKmh', () => {
  it('converts m/s to rounded km/h, passing null through', () => {
    expect(speedKmh(null)).toBeNull();
    expect(speedKmh(undefined)).toBeNull();
    expect(speedKmh(0)).toBe(0);
    expect(speedKmh(10)).toBe(36);
    expect(speedKmh(5)).toBe(18); // ~cycling
  });
});
