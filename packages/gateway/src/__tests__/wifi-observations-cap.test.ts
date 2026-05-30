import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { processWifi } from '../processors/wifi.js';
import type { PushWifiItem } from '../types/index.js';

const USER = 'user-wifi-1';

interface ObsDoc { place_observations?: Array<{ place_id: string; count: number; last_seen: string }> }

/**
 * ES mock: network doc already has N place_observations; a recent GPS fix at
 * place "p-new" exists so a new observation is added. Captures the indexed doc.
 */
function makeEs(existingObsCount: number): { es: Client; lastIndexed: () => ObsDoc | null } {
  let lastNetworkDoc: ObsDoc | null = null;
  const existingObs = Array.from({ length: existingObsCount }, (_, i) => ({
    place_id: `p-${i}`,
    place_name: `Place ${i}`,
    count: existingObsCount - i, // p-0 has the highest count
    last_seen: '2026-05-30T09:00:00.000Z',
  }));

  const es = {
    // getRecentGpsWithPlace: return a recent fix at a brand-new place.
    search: vi.fn(async () => ({
      hits: {
        hits: [
          {
            _source: {
              timestamp: '2026-05-30T10:00:00.000Z',
              matched_place_id: 'p-new',
              matched_place: 'New Place',
            },
          },
        ],
      },
    })),
    get: vi.fn(async () => ({
      _source: {
        user_id: USER,
        bssid: 'aa:bb',
        place_observations: existingObs,
        total_observations: existingObsCount,
        first_seen: '2026-05-01T00:00:00.000Z',
        last_seen: '2026-05-30T09:00:00.000Z',
        created_at: '2026-05-01T00:00:00.000Z',
        updated_at: '2026-05-30T09:00:00.000Z',
      },
    })),
    index: vi.fn(async (req: { index: string; document: ObsDoc }) => {
      if (req.index === 'll5_knowledge_networks') lastNetworkDoc = req.document;
      return { result: 'updated' };
    }),
  } as unknown as Client;

  return { es, lastIndexed: () => lastNetworkDoc };
}

function wifi(): PushWifiItem {
  return {
    type: 'wifi',
    timestamp: '2026-05-30T10:00:30.000Z',
    connected: true,
    ssid: 'net',
    bssid: 'aa:bb',
  } as PushWifiItem;
}

beforeEach(() => vi.clearAllMocks());

describe('upsertNetworkObservation — G8 place_observations cap', () => {
  it('caps place_observations at 20 keeping the highest-count entries', async () => {
    // 20 existing + 1 new = 21 → must be pruned back to 20.
    const { es, lastIndexed } = makeEs(20);
    await processWifi(es, USER, wifi());
    const doc = lastIndexed();
    expect(doc).not.toBeNull();
    expect(doc!.place_observations).toHaveLength(20);
    // The lowest-count existing entry (p-19, count 1) should be the one dropped.
    const ids = doc!.place_observations!.map((o) => o.place_id);
    expect(ids).not.toContain('p-19');
    expect(ids).toContain('p-0'); // highest count retained
  });

  it('does not prune when under the cap', async () => {
    const { es, lastIndexed } = makeEs(5);
    await processWifi(es, USER, wifi());
    const doc = lastIndexed();
    // 5 existing + 1 new = 6, under cap.
    expect(doc!.place_observations).toHaveLength(6);
  });
});
