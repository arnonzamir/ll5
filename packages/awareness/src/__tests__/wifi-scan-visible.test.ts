import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { LocationService } from '../services/location-service.js';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { WifiRepository } from '../repositories/interfaces/wifi.repository.js';
import type { WifiScanRepository } from '../repositories/interfaces/wifi-scan.repository.js';
import type { WifiScan } from '../types/wifi.js';

const USER = 'user-visible-1';

/** Known-network docs by mget id — aa:aa manually bound to Home, bb:bb
 *  auto-learned visible at Home (dominant count over threshold). cc:cc unknown. */
const NETWORK_DOCS: Record<string, Record<string, unknown>> = {
  [`${USER}::aa:aa`]: {
    user_id: USER,
    bssid: 'aa:aa',
    manual_place_id: 'home-uuid',
    manual_place_name: 'Home',
  },
  [`${USER}::bb:bb`]: {
    user_id: USER,
    bssid: 'bb:bb',
    binding: 'visible',
    place_observations: [
      { place_id: 'home-uuid', place_name: 'Home', count: 5, last_seen: '2026-06-30T00:00:00.000Z' },
    ],
  },
};

function freshScan(ageMs = 2 * 60 * 1000): WifiScan {
  return {
    id: 'scan-1',
    userId: USER,
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    networks: [
      { ssid: 'shrimp3', bssid: 'aa:aa', rssi: -58, frequencyMhz: 5240 },
      { ssid: 'neighbor', bssid: 'bb:bb', rssi: -71, frequencyMhz: 2412 },
      { ssid: 'stranger', bssid: 'cc:cc', rssi: -74, frequencyMhz: 2437 },
    ],
    connectedBssid: null,
  };
}

function makeService(scan: WifiScan | null) {
  const locationRepo = {
    getLatest: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue([]),
  } as unknown as LocationRepository;
  const wifiRepo = { getLatest: vi.fn().mockResolvedValue(null) } as unknown as WifiRepository;
  const wifiScanRepo: WifiScanRepository = { getLatest: vi.fn().mockResolvedValue(scan) };
  const mget = vi.fn(async ({ ids }: { ids: string[] }) => ({
    docs: ids.map((id) =>
      NETWORK_DOCS[id]
        ? { _id: id, found: true, _source: NETWORK_DOCS[id] }
        : { _id: id, found: false },
    ),
  }));
  const es = { mget, get: vi.fn() } as unknown as Client;
  return { svc: new LocationService(locationRepo, wifiRepo, es, wifiScanRepo), mget };
}

describe('where_is_user wifi.visible block (DECISION-021)', () => {
  it('exposes the visible block with matched known networks', async () => {
    const { svc } = makeService(freshScan());
    const r = await svc.getCurrentLocation(USER);

    expect(r.wifi).toBeDefined();
    expect(r.wifi!.connected).toBe(false);
    expect(r.wifi!.visible).toMatchObject({
      total_visible: 3,
      known: [
        { place: 'Home', ssid: 'shrimp3', rssi: -58 },
        { place: 'Home', ssid: 'neighbor', rssi: -71 },
      ],
    });
    expect(r.wifi!.visible!.scan_age_s).toBeGreaterThanOrEqual(119);
    expect(r.wifi!.visible!.scan_age_s).toBeLessThan(180);
  });

  it('FEEDS the matched set into the shared resolver — place resolves from the fingerprint', async () => {
    const { svc } = makeService(freshScan());
    const r = await svc.getCurrentLocation(USER);

    // No GPS, no connected wifi — only the visible fingerprint places the user.
    expect(r.place).toBe('Home');
    expect(r.place_id).toBe('home-uuid');
    expect(r.source).toBe('wifi_scan');
    expect(r.confidence).toBe('medium');
  });

  it('OMITS the visible block (and the resolver tier) for a stale scan', async () => {
    const { svc, mget } = makeService(freshScan(11 * 60 * 1000));
    const r = await svc.getCurrentLocation(USER);

    expect(r.wifi).toBeUndefined();
    expect(r.place).toBeNull();
    expect(r.source).toBe('none');
    expect(mget).not.toHaveBeenCalled(); // stale scan is not even matched
  });

  it('handles no scan at all (repo empty) exactly like before', async () => {
    const { svc } = makeService(null);
    const r = await svc.getCurrentLocation(USER);
    expect(r.wifi).toBeUndefined();
    expect(r.source).toBe('none');
  });

  it('unknown-only scan yields the block with empty known and no place claim', async () => {
    const scan = freshScan();
    scan.networks = [{ ssid: 'stranger', bssid: 'cc:cc', rssi: -60 }];
    const { svc } = makeService(scan);
    const r = await svc.getCurrentLocation(USER);

    expect(r.wifi!.visible).toMatchObject({ total_visible: 1, known: [] });
    expect(r.place).toBeNull();
  });

  it('degrades to no visible signal when the networks mget fails', async () => {
    const { svc } = makeService(freshScan());
    (svc as unknown as { es: { mget: () => Promise<never> } }).es.mget = vi
      .fn()
      .mockRejectedValue(new Error('es down'));
    const r = await svc.getCurrentLocation(USER);

    expect(r.wifi!.visible).toMatchObject({ total_visible: 3, known: [] });
    expect(r.place).toBeNull();
  });
});
