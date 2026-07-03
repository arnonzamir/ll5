import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { ElasticsearchNetworkRepository } from '../repositories/elasticsearch/network.repository.js';
import { registerNetworkTools } from '../tools/networks.js';
import type { NetworkRepository } from '../repositories/interfaces/network.repository.js';
import type { PlaceRepository } from '../repositories/interfaces/place.repository.js';
import type { KnownNetwork } from '../types/network.js';
import { captureTools, parseToolResponse } from './_helpers.js';

const USER_ID = 'user-net-1';

const legacyDoc = {
  user_id: USER_ID,
  bssid: 'aa:bb:cc:dd:ee:ff',
  ssid: 'shrimp3',
  place_observations: [
    { place_id: 'home-uuid', place_name: 'Home', count: 7, last_seen: '2026-06-30T00:00:00.000Z' },
  ],
  total_observations: 7,
  first_seen: '2026-06-01T00:00:00.000Z',
  last_seen: '2026-06-30T00:00:00.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-30T00:00:00.000Z',
  // NOTE: no `binding` field — a pre-DECISION-021 row.
};

const visibleDoc = {
  ...legacyDoc,
  bssid: '11:22:33:44:55:66',
  ssid: 'neighbor-ap',
  binding: 'visible' as const,
};

function makeEsClient(overrides: Record<string, unknown> = {}): Client {
  return {
    search: vi.fn().mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } }),
    get: vi.fn().mockResolvedValue({ _source: legacyDoc }),
    index: vi.fn().mockResolvedValue({ result: 'created' }),
    ...overrides,
  } as unknown as Client;
}

describe('ElasticsearchNetworkRepository — binding (DECISION-021)', () => {
  let esClient: Client;
  let repo: ElasticsearchNetworkRepository;

  beforeEach(() => {
    esClient = makeEsClient();
    repo = new ElasticsearchNetworkRepository(esClient);
  });

  it('defaults legacy docs (no binding field) to connected', async () => {
    const network = await repo.getByBssid(USER_ID, 'aa:bb:cc:dd:ee:ff');
    expect(network?.binding).toBe('connected');
  });

  it('surfaces an explicit visible binding', async () => {
    esClient = makeEsClient({ get: vi.fn().mockResolvedValue({ _source: visibleDoc }) });
    repo = new ElasticsearchNetworkRepository(esClient);
    const network = await repo.getByBssid(USER_ID, '11:22:33:44:55:66');
    expect(network?.binding).toBe('visible');
  });

  it('list maps binding per doc (legacy → connected)', async () => {
    esClient = makeEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          total: { value: 2 },
          hits: [
            { _id: '1', _source: legacyDoc },
            { _id: '2', _source: visibleDoc },
          ],
        },
      }),
    });
    repo = new ElasticsearchNetworkRepository(esClient);
    const networks = await repo.list(USER_ID);
    expect(networks.map((n) => n.binding)).toEqual(['connected', 'visible']);
  });

  it('setManualPlace PRESERVES a visible binding', async () => {
    esClient = makeEsClient({ get: vi.fn().mockResolvedValue({ _source: visibleDoc }) });
    repo = new ElasticsearchNetworkRepository(esClient);
    await repo.setManualPlace(USER_ID, '11:22:33:44:55:66', 'home-uuid', 'Home');

    const indexed = vi.mocked(esClient.index).mock.calls[0][0] as { document: { binding?: string } };
    expect(indexed.document.binding).toBe('visible');
  });

  it('clearManualPlace PRESERVES the binding', async () => {
    esClient = makeEsClient({
      get: vi.fn().mockResolvedValue({ _source: { ...visibleDoc, manual_place_id: 'home-uuid', manual_place_name: 'Home' } }),
    });
    repo = new ElasticsearchNetworkRepository(esClient);
    await repo.clearManualPlace(USER_ID, '11:22:33:44:55:66');

    const indexed = vi.mocked(esClient.index).mock.calls[0][0] as { document: { binding?: string } };
    expect(indexed.document.binding).toBe('visible');
  });
});

describe('list_known_networks tool — exposes binding', () => {
  it('includes the binding field per network', async () => {
    const networks: KnownNetwork[] = [
      {
        bssid: 'aa:bb:cc:dd:ee:ff',
        ssid: 'shrimp3',
        placeObservations: [],
        binding: 'connected',
        totalObservations: 7,
        firstSeen: '2026-06-01T00:00:00.000Z',
        lastSeen: '2026-06-30T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      },
      {
        bssid: '11:22:33:44:55:66',
        ssid: 'neighbor-ap',
        placeObservations: [],
        binding: 'visible',
        totalObservations: 3,
        firstSeen: '2026-06-20T00:00:00.000Z',
        lastSeen: '2026-06-30T00:00:00.000Z',
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      },
    ];
    const networkRepo = { list: vi.fn().mockResolvedValue(networks) } as unknown as NetworkRepository;
    const placeRepo = {} as PlaceRepository;

    const tools = captureTools((server) =>
      registerNetworkTools(server, networkRepo, placeRepo, () => USER_ID),
    );
    const res = await tools.get('list_known_networks')!({});
    const parsed = parseToolResponse<{ networks: Array<{ bssid: string; binding: string }> }>(res);

    expect(parsed.networks.map((n) => n.binding)).toEqual(['connected', 'visible']);
  });
});
