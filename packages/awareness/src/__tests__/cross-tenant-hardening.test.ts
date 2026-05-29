import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ElasticsearchCalendarEventRepository } from '../repositories/elasticsearch/calendar-event.repository.js';
import { LocationService } from '../services/location-service.js';
import { logger } from '../utils/logger.js';

const OWNER = 'user-owner';
const OTHER = 'user-attacker';

// ===========================================================================
// ITEM 1 — calendar-event upsert by caller-supplied id has no owner check
// ===========================================================================
describe('ElasticsearchCalendarEventRepository.upsert — owner verification by id', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseData = {
    title: 'Standup',
    startTime: '2026-05-29T09:00:00.000Z',
    endTime: '2026-05-29T09:15:00.000Z',
  };

  it('refuses to overwrite a doc owned by another user (cross-user denial)', async () => {
    // The doc at this id already belongs to OWNER.
    const get = vi
      .fn()
      .mockResolvedValue({ _id: 'evt-1', _source: { user_id: OWNER, title: 'Owner event' } });
    const index = vi.fn().mockResolvedValue({ _id: 'evt-1', result: 'updated' });
    const client = { get, index } as never;
    const repo = new ElasticsearchCalendarEventRepository(client);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(repo.upsert(OTHER, { ...baseData, id: 'evt-1' })).rejects.toThrow();

    // The attacker's upsert must NOT overwrite the owner's doc.
    expect(index).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'cross_user_access_denied',
      expect.objectContaining({
        actor_user_id: OTHER,
        owner_user_id: OWNER,
        resource: 'calendar_event',
        id: 'evt-1',
      }),
    );
    warnSpy.mockRestore();
  });

  it('updates a doc the caller owns when id is supplied', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ _id: 'evt-1', _source: { user_id: OWNER, title: 'Owner event' } });
    const index = vi.fn().mockResolvedValue({ _id: 'evt-1', result: 'updated' });
    const client = { get, index } as never;
    const repo = new ElasticsearchCalendarEventRepository(client);

    const result = await repo.upsert(OWNER, { ...baseData, id: 'evt-1' });

    expect(index).toHaveBeenCalledTimes(1);
    expect(index.mock.calls[0][0].id).toBe('evt-1');
    expect(index.mock.calls[0][0].document.user_id).toBe(OWNER);
    expect(result.id).toBe('evt-1');
  });

  it('trusted ingest: id supplied but no existing doc (404) proceeds and indexes', async () => {
    const get = vi.fn().mockRejectedValue({ meta: { statusCode: 404 } });
    const index = vi.fn().mockResolvedValue({ _id: 'evt-new', result: 'created' });
    const client = { get, index } as never;
    const repo = new ElasticsearchCalendarEventRepository(client);

    const result = await repo.upsert(OWNER, { ...baseData, id: 'evt-new' });

    expect(index).toHaveBeenCalledTimes(1);
    expect(index.mock.calls[0][0].id).toBe('evt-new');
    expect(result.id).toBe('evt-new');
  });

  it('no id supplied: generates an id and indexes without a pre-read', async () => {
    const get = vi.fn();
    const index = vi.fn().mockResolvedValue({ result: 'created' });
    const client = { get, index } as never;
    const repo = new ElasticsearchCalendarEventRepository(client);

    const result = await repo.upsert(OWNER, baseData);

    expect(get).not.toHaveBeenCalled();
    expect(index).toHaveBeenCalledTimes(1);
    expect(result.id).toBeTruthy();
    expect(index.mock.calls[0][0].document.user_id).toBe(OWNER);
  });
});

// ===========================================================================
// ITEM 2 — location-service.lookupBssidPlace must recheck _source.user_id
// ===========================================================================
describe('LocationService.lookupBssidPlace — user_id recheck on network doc', () => {
  beforeEach(() => vi.clearAllMocks());

  // Build a LocationService whose getLatest stubs feed a fresh, connected wifi
  // signal so getCurrentLocation reaches lookupBssidPlace.
  function makeService(esGet: ReturnType<typeof vi.fn>) {
    const now = new Date().toISOString();
    const locationRepo = {
      getLatest: vi.fn(async () => null),
    } as never;
    const wifiRepo = {
      getLatest: vi.fn(async () => ({
        bssid: 'aa:bb:cc:dd:ee:ff',
        ssid: 'HomeNet',
        connected: true,
        timestamp: now,
      })),
    } as never;
    const es = { get: esGet } as never;
    return new LocationService(locationRepo, wifiRepo, es);
  }

  it('returns the place when the network doc belongs to the caller', async () => {
    const esGet = vi.fn().mockResolvedValue({
      _id: `${OWNER}::aa:bb:cc:dd:ee:ff`,
      _source: {
        user_id: OWNER,
        manual_place_id: 'place-home',
        manual_place_name: 'Home',
      },
    });
    const svc = makeService(esGet);

    const result = await svc.getCurrentLocation(OWNER);

    expect(result.wifi?.place_from_bssid).toEqual({
      place_id: 'place-home',
      place_name: 'Home',
    });
  });

  it('refuses a network doc whose user_id is not the caller (recheck contract)', async () => {
    // Deterministic id is server-derived, so this only fires if the stored
    // doc's user_id diverges from the caller. The recheck locks that contract.
    const esGet = vi.fn().mockResolvedValue({
      _id: `${OTHER}::aa:bb:cc:dd:ee:ff`,
      _source: {
        user_id: OWNER,
        manual_place_id: 'place-home',
        manual_place_name: 'Home',
      },
    });
    const svc = makeService(esGet);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await svc.getCurrentLocation(OTHER);

    expect(result.wifi?.place_from_bssid).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'cross_user_access_denied',
      expect.objectContaining({
        actor_user_id: OTHER,
        owner_user_id: OWNER,
        resource: 'network',
        id: `${OTHER}::aa:bb:cc:dd:ee:ff`,
      }),
    );
    warnSpy.mockRestore();
  });
});
