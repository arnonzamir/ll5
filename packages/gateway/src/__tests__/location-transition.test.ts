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
    expect(sendFCMNotification).toHaveBeenCalledTimes(1);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
  });
});
