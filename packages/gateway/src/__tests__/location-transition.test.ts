import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import type { PushLocationItem } from '../types/index.js';

// Geocode always resolves the town (so the city-level fallback is "Zikhron Yaakov").
vi.mock('../utils/geocoding.js', () => ({
  reverseGeocode: vi.fn(async () => ({ address: 'somewhere in town', city: 'Zikhron Yaakov' })),
}));

const { insertSystemMessage, sendFCMNotification, writeNotableEvent } = vi.hoisted(() => ({
  insertSystemMessage: vi.fn(async () => {}),
  sendFCMNotification: vi.fn(async () => {}),
  writeNotableEvent: vi.fn(async () => {}),
}));
vi.mock('../utils/system-message.js', () => ({ insertSystemMessage }));
vi.mock('../utils/fcm-sender.js', () => ({ sendFCMNotification }));
vi.mock('../processors/notable.js', () => ({ writeNotableEvent }));

import { processLocation } from '../processors/location.js';
import { reverseGeocode } from '../utils/geocoding.js';

const mockGeocode = vi.mocked(reverseGeocode);

const USER = 'user-flap';
const HOME_STATE = { user_id: USER, label: 'Home', kind: 'place', place_id: 'home', lat: 32.0, lon: 34.0 };

/**
 * @param opts.wifiConnectedHome  latest wifi is a fresh connect to the home BSSID
 * @param opts.placeMatch         ll5_knowledge_places returns a 100m match
 */
function makeEs(opts: { wifiConnectedHome: boolean; placeMatch?: { place_id: string; place_name: string } }): Client {
  const nowIso = new Date().toISOString();
  return {
    search: vi.fn(async (req: { index: string }) => {
      if (req.index === 'll5_awareness_wifi_connections') {
        if (!opts.wifiConnectedHome) return { hits: { hits: [{ _source: { bssid: null, connected: false, timestamp: nowIso } }] } };
        return { hits: { hits: [{ _source: { bssid: 'AA:BB', ssid: 'shrimp3', connected: true, timestamp: nowIso } }] } };
      }
      if (req.index === 'll5_knowledge_places') {
        return { hits: { hits: opts.placeMatch ? [{ _id: opts.placeMatch.place_id, _source: { name: opts.placeMatch.place_name, user_id: USER } }] : [] } };
      }
      return { hits: { hits: [] } }; // getPreviousLocation: none
    }),
    get: vi.fn(async (req: { index: string }) => {
      if (req.index === 'll5_awareness_location_state') return { _source: HOME_STATE };
      if (req.index === 'll5_knowledge_networks') {
        return { _source: { user_id: USER, place_observations: [{ place_id: 'home', place_name: 'Home', count: 18063 }] } };
      }
      throw { meta: { statusCode: 404 } };
    }),
    index: vi.fn(async () => ({ result: 'created' })),
  } as unknown as Client;
}

const pool = {} as Pool;
function loc(over: Partial<PushLocationItem>): PushLocationItem {
  return { type: 'location', timestamp: new Date().toISOString(), lat: 32.0015, lon: 34.0, ...over } as PushLocationItem;
}

beforeEach(() => vi.clearAllMocks());

describe('place transition — wifi anchor + hysteresis (no home flapping)', () => {
  it('does NOT push a city transition when on home wifi and GPS drifted off the 100m radius', async () => {
    // GPS fresh, no place match (drifted), but connected to the confident home BSSID.
    const es = makeEs({ wifiConnectedHome: true });
    await processLocation(es, USER, loc({ accuracy_m: 90 }), undefined, pool, null);
    expect(sendFCMNotification).not.toHaveBeenCalled();
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('does NOT flip to city on a LOW-accuracy fix even without wifi (hysteresis holds Home)', async () => {
    const es = makeEs({ wifiConnectedHome: false });
    await processLocation(es, USER, loc({ accuracy_m: 130 }), undefined, pool, null);
    expect(sendFCMNotification).not.toHaveBeenCalled();
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('DOES transition to city on a clean, good-accuracy fix with no wifi anchor (real departure)', async () => {
    const es = makeEs({ wifiConnectedHome: false });
    await processLocation(es, USER, loc({ accuracy_m: 20, lat: 32.05, lon: 34.05 }), undefined, pool, null);
    // Gateway no longer pushes the user directly — it wakes the agent with a
    // labeled event and lets the agent decide whether/how to notify.
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(insertSystemMessage.mock.calls[0][2] as string).toContain('Left Home');
    expect(sendFCMNotification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stops + pulse policy: a long drive must NOT firehose town-by-town; it emits
// one rich "trip pulse" at most every TRIP_PULSE_MS, plus a push when you stop.
// ---------------------------------------------------------------------------
const DRIVE_STATE = (over: Record<string, unknown> = {}) => ({
  user_id: USER, label: 'Hadera', kind: 'city', city: 'Hadera',
  lat: 32.4, lon: 34.9, last_motion: 'driving', ...over,
});

/** ES whose location_state is a driving city-state; no place match, no wifi anchor. */
function makeDriveEs(stateOver: Record<string, unknown> = {}): Client {
  return {
    search: vi.fn(async () => ({ hits: { hits: [] } })),
    get: vi.fn(async (req: { index: string }) => {
      if (req.index === 'll5_awareness_location_state') return { _source: DRIVE_STATE(stateOver) };
      throw { meta: { statusCode: 404 } };
    }),
    index: vi.fn(async () => ({ result: 'created' })),
  } as unknown as Client;
}

describe('drive cadence — stops + trip pulse, not town-by-town', () => {
  it('SUPPRESSES a town change while driving within the pulse window', async () => {
    // Pulsed 1 min ago; now a fresh driving fix in a different town → stay silent.
    mockGeocode.mockResolvedValueOnce({ address: 'hwy', city: 'Kfar Saba', road: 'Route 6' });
    const es = makeDriveEs({ last_pulse_at: Date.now() - 60_000 });
    await processLocation(es, USER, loc({ accuracy_m: 20, lat: 32.2, lon: 34.9, speed_mps: 25, bearing_deg: 180 }), undefined, pool, null);
    expect(insertSystemMessage).not.toHaveBeenCalled();
    expect(sendFCMNotification).not.toHaveBeenCalled();
  });

  it('WAKES the agent with one rich "En route" pulse once the pulse window has elapsed', async () => {
    mockGeocode.mockResolvedValueOnce({ address: 'hwy', city: 'Kfar Saba', road: 'Route 6' });
    const es = makeDriveEs({ last_pulse_at: Date.now() - 15 * 60_000 });
    await processLocation(es, USER, loc({ accuracy_m: 20, lat: 32.2, lon: 34.9, speed_mps: 25, bearing_deg: 180 }), undefined, pool, null);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    const msg = insertSystemMessage.mock.calls[0][2] as string;
    expect(msg).toContain('En route');
    expect(msg).toContain('Route 6');
    expect(msg.toLowerCase()).toContain('heading south');
    expect(sendFCMNotification).not.toHaveBeenCalled();
  });

  it('WAKES the agent with a "Stopped" event when you stop (driving → stationary), even within the pulse window', async () => {
    mockGeocode.mockResolvedValueOnce({ address: 'side st', city: 'Kfar Saba', road: 'Weizmann St' });
    const es = makeDriveEs({ last_pulse_at: Date.now() - 60_000 });
    await processLocation(es, USER, loc({ accuracy_m: 20, lat: 32.2, lon: 34.9, speed_mps: 0 }), undefined, pool, null);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    const msg = insertSystemMessage.mock.calls[0][2] as string;
    expect(msg).toContain('Stopped');
    expect(msg).toContain('Weizmann St');
    expect(sendFCMNotification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Drive-past suppression: a known-place match while genuinely MOVING (derived
// from the previous fix — the phone's reported speed is unreliable) is a fly-by,
// not a visit, so we must NOT label "Arrived at X". This is the recurring
// "you're at Optika/Keitz while I only drove past" bug.
// ---------------------------------------------------------------------------
describe('drive-past place suppression (derived speed)', () => {
  it('SUPPRESSES a known-place match when moving fast, even with a low reported speed', async () => {
    const prevTs = new Date(Date.now() - 20_000).toISOString(); // 20s ago
    const es = {
      search: vi.fn(async (req: { index: string }) => {
        if (req.index === 'll5_awareness_wifi_connections') return { hits: { hits: [] } };
        if (req.index === 'll5_knowledge_places') {
          return { hits: { hits: [{ _id: 'optika', _source: { name: 'Optika Cohen', user_id: USER, geo: { lat: 32.0, lon: 34.0 }, radius_m: 100 } }] } };
        }
        if (req.index === 'll5_awareness_locations') {
          // ~300m away, 20s ago → derived ~54 km/h (driving), even though the
          // phone reports a near-zero speed.
          return { hits: { hits: [{ _source: { location: { lat: 32.0027, lon: 34.0 }, timestamp: prevTs, matched_place: null } }] } };
        }
        return { hits: { hits: [] } };
      }),
      get: vi.fn(async (req: { index: string }) => {
        if (req.index === 'll5_awareness_location_state') {
          return { _source: { user_id: USER, label: 'Zikhron Yaakov', kind: 'city', city: 'Zikhron Yaakov', lat: 32.0027, lon: 34.0, last_motion: 'driving' } };
        }
        throw { meta: { statusCode: 404 } };
      }),
      index: vi.fn(async () => ({ result: 'created' })),
    } as unknown as Client;

    mockGeocode.mockResolvedValueOnce({ address: 'on the road', city: 'Zikhron Yaakov', road: 'HaDagan' });
    await processLocation(es, USER, loc({ accuracy_m: 20, lat: 32.0, lon: 34.0, speed_mps: 2 }), undefined, pool, null);

    // Whatever it surfaced, it must NOT be an arrival at the place we drove past.
    const all = (insertSystemMessage.mock.calls as unknown[][]).map((c) => c[2] as string).join('\n');
    expect(all).not.toContain('Arrived at Optika Cohen');
    expect(all).not.toContain('[place match]');
  });
});
