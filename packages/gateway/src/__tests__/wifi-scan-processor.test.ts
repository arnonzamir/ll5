import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { processWifiScan } from '../processors/wifi-scan.js';
import { PushItemSchema, type PushWifiScanItem } from '../types/index.js';

const USER = 'user-scan-1';
const SCAN_TS = '2026-07-01T10:00:00.000Z';
const SCANS_INDEX = 'll5_awareness_wifi_scans';
const NETWORKS_INDEX = 'll5_knowledge_networks';
const STATE_INDEX = 'll5_awareness_location_state';

interface IndexedCall {
  index: string;
  id?: string;
  document: Record<string, unknown>;
}

interface EsOptions {
  /** Location-state doc (null = 404). */
  state?: Record<string, unknown> | null;
  /** Existing network docs by `${USER}::${bssid}` (others 404). */
  networkDocs?: Record<string, Record<string, unknown>>;
  /** BSSIDs already visible-bound to the place (the cap query result). */
  visibleAtPlace?: string[];
}

function makeEs(opts: EsOptions = {}): { es: Client; indexed: IndexedCall[] } {
  const indexed: IndexedCall[] = [];
  const es = {
    index: vi.fn(async (req: IndexedCall) => {
      indexed.push(req);
      return { result: 'created' };
    }),
    get: vi.fn(async (req: { index: string; id: string }) => {
      if (req.index === STATE_INDEX) {
        if (opts.state === null || opts.state === undefined) {
          throw Object.assign(new Error('not found'), { meta: { statusCode: 404 } });
        }
        return { _source: opts.state };
      }
      const doc = opts.networkDocs?.[req.id];
      if (!doc) throw Object.assign(new Error('not found'), { meta: { statusCode: 404 } });
      return { _source: doc };
    }),
    search: vi.fn(async () => ({
      hits: { hits: (opts.visibleAtPlace ?? []).map((b) => ({ _source: { bssid: b } })) },
    })),
  } as unknown as Client;
  return { es, indexed };
}

/** State doc: confidently at Home, GPS confirmed seconds before the scan. */
const AT_HOME = {
  user_id: USER,
  label: 'Home',
  kind: 'place',
  place_id: 'home-uuid',
  last_seen: '2026-07-01T09:59:00.000Z',
};

function scanItem(over: Partial<PushWifiScanItem['data']> = {}): PushWifiScanItem {
  return {
    type: 'wifi_scan',
    data: {
      timestamp: SCAN_TS,
      networks: [
        { ssid: 'shrimp3', bssid: 'aa:aa', rssi: -58, frequency_mhz: 5240 },
        { ssid: 'neighbor', bssid: 'bb:bb', rssi: -72, frequency_mhz: 2412 },
        { ssid: 'far-away', bssid: 'cc:cc', rssi: -80, frequency_mhz: 2437 }, // below learn floor
      ],
      connected_bssid: 'aa:aa',
      ...over,
    },
  };
}

const scanDocs = (indexed: IndexedCall[]) => indexed.filter((c) => c.index === SCANS_INDEX);
const networkWrites = (indexed: IndexedCall[]) => indexed.filter((c) => c.index === NETWORKS_INDEX);

beforeEach(() => vi.clearAllMocks());

describe('wifi_scan webhook item — schema validation', () => {
  it('accepts a contract-shaped item', () => {
    expect(PushItemSchema.safeParse(scanItem()).success).toBe(true);
  });

  it('accepts null ssid and absent connected_bssid', () => {
    const item = {
      type: 'wifi_scan',
      data: { timestamp: SCAN_TS, networks: [{ ssid: null, bssid: 'aa:aa', rssi: -60 }] },
    };
    expect(PushItemSchema.safeParse(item).success).toBe(true);
  });

  it("accepts a hidden network with the ssid key OMITTED (Android's Moshi drops null keys) and defaults it to null", () => {
    const item = {
      type: 'wifi_scan',
      data: { timestamp: SCAN_TS, networks: [{ bssid: 'aa:aa', rssi: -60 }] },
    };
    const parsed = PushItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'wifi_scan') {
      expect(parsed.data.data.networks[0].ssid).toBeNull();
    }
  });

  it('rejects a network without a bssid', () => {
    const item = {
      type: 'wifi_scan',
      data: { timestamp: SCAN_TS, networks: [{ ssid: 'x', rssi: -60 }] },
    };
    expect(PushItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    const item = { type: 'wifi_scan', data: { timestamp: 'yesterday', networks: [] } };
    expect(PushItemSchema.safeParse(item).success).toBe(false);
  });
});

describe('processWifiScan — storage', () => {
  it('stores ONE scan doc with the contract shape', async () => {
    const { es, indexed } = makeEs({ state: null });
    await processWifiScan(es, USER, scanItem());

    const scans = scanDocs(indexed);
    expect(scans).toHaveLength(1);
    expect(scans[0].document).toEqual({
      user_id: USER,
      timestamp: SCAN_TS,
      networks: [
        { ssid: 'shrimp3', bssid: 'aa:aa', rssi: -58, frequency_mhz: 5240 },
        { ssid: 'neighbor', bssid: 'bb:bb', rssi: -72, frequency_mhz: 2412 },
        { ssid: 'far-away', bssid: 'cc:cc', rssi: -80, frequency_mhz: 2437 },
      ],
      connected_bssid: 'aa:aa',
    });
  });

  it('stores connected_bssid as null when absent', async () => {
    const { es, indexed } = makeEs({ state: null });
    await processWifiScan(es, USER, scanItem({ connected_bssid: undefined }));
    expect(scanDocs(indexed)[0].document.connected_bssid).toBeNull();
  });
});

describe('processWifiScan — auto-learn gating', () => {
  it('does NOT learn when there is no location state', async () => {
    const { es, indexed } = makeEs({ state: null });
    await processWifiScan(es, USER, scanItem());
    expect(networkWrites(indexed)).toHaveLength(0);
  });

  it('does NOT learn when the state is city-level (not a known place)', async () => {
    const { es, indexed } = makeEs({
      state: { ...AT_HOME, kind: 'city', label: 'Haifa', place_id: undefined },
    });
    await processWifiScan(es, USER, scanItem());
    expect(networkWrites(indexed)).toHaveLength(0);
  });

  it('does NOT learn when the place confirmation is older than the scan window', async () => {
    const { es, indexed } = makeEs({
      state: { ...AT_HOME, last_seen: '2026-07-01T09:00:00.000Z' }, // 1h before the scan
    });
    await processWifiScan(es, USER, scanItem());
    expect(networkWrites(indexed)).toHaveLength(0);
  });
});

describe('processWifiScan — auto-learn at a known place', () => {
  it('upserts visible bindings for networks at/above -75 dBm and skips weaker ones', async () => {
    const { es, indexed } = makeEs({ state: AT_HOME });
    await processWifiScan(es, USER, scanItem());

    const writes = networkWrites(indexed);
    expect(writes.map((w) => w.id)).toEqual([`${USER}::aa:aa`, `${USER}::bb:bb`]); // no cc:cc (-80)

    const created = writes[0].document as {
      binding?: string;
      place_observations?: Array<{ place_id: string; count: number }>;
      total_observations?: number;
      user_id?: string;
    };
    expect(created.user_id).toBe(USER);
    expect(created.binding).toBe('visible');
    expect(created.place_observations).toEqual([
      { place_id: 'home-uuid', place_name: 'Home', count: 1, last_seen: SCAN_TS },
    ]);
    expect(created.total_observations).toBe(1);
  });

  it('preserves an existing connected binding (scan sightings only add weight)', async () => {
    const { es, indexed } = makeEs({
      state: AT_HOME,
      networkDocs: {
        [`${USER}::aa:aa`]: {
          user_id: USER,
          bssid: 'aa:aa',
          // legacy doc: no binding field = connected
          place_observations: [
            { place_id: 'home-uuid', place_name: 'Home', count: 4, last_seen: '2026-06-30T00:00:00.000Z' },
          ],
          total_observations: 4,
          first_seen: '2026-06-01T00:00:00.000Z',
          last_seen: '2026-06-30T00:00:00.000Z',
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-30T00:00:00.000Z',
        },
      },
    });
    await processWifiScan(es, USER, scanItem());

    const doc = networkWrites(indexed).find((w) => w.id === `${USER}::aa:aa`)!.document as {
      binding?: string;
      place_observations?: Array<{ count: number }>;
    };
    expect(doc.binding).toBeUndefined(); // legacy stays legacy-connected
    expect(doc.place_observations?.[0].count).toBe(5); // incremented
  });

  it('CAP: does not create an 11th visible binding for the place, but still increments members', async () => {
    const tenOthers = Array.from({ length: 10 }, (_, i) => `vv:${i}`);
    const { es, indexed } = makeEs({
      state: AT_HOME,
      // aa:aa is NOT among the 10 → capped out. bb:bb IS a member → increments.
      visibleAtPlace: [...tenOthers.slice(0, 9), 'bb:bb'],
      networkDocs: {
        [`${USER}::bb:bb`]: {
          user_id: USER,
          bssid: 'bb:bb',
          binding: 'visible',
          place_observations: [
            { place_id: 'home-uuid', place_name: 'Home', count: 2, last_seen: '2026-06-30T00:00:00.000Z' },
          ],
          total_observations: 2,
          first_seen: '2026-06-01T00:00:00.000Z',
          last_seen: '2026-06-30T00:00:00.000Z',
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-30T00:00:00.000Z',
        },
      },
    });
    await processWifiScan(es, USER, scanItem());

    const writes = networkWrites(indexed);
    // aa:aa would be a NEW visible binding → skipped at the cap.
    expect(writes.map((w) => w.id)).toEqual([`${USER}::bb:bb`]);
    const doc = writes[0].document as { place_observations?: Array<{ count: number }> };
    expect(doc.place_observations?.[0].count).toBe(3);
  });

  it('within one scan, learning stops once the cap fills', async () => {
    // 9 pre-existing visible bindings; the scan offers 2 new candidates.
    // Only the first fits under the cap of 10.
    const nine = Array.from({ length: 9 }, (_, i) => `vv:${i}`);
    const { es, indexed } = makeEs({ state: AT_HOME, visibleAtPlace: nine });
    await processWifiScan(es, USER, scanItem());

    const writes = networkWrites(indexed);
    expect(writes.map((w) => w.id)).toEqual([`${USER}::aa:aa`]); // bb:bb over cap
  });
});
