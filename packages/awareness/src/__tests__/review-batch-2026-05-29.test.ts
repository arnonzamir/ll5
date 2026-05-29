import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @ll5/shared so logAudit doesn't write to ES.
// Hoisted before any tool module imports it.
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ll5/shared');
  return {
    ...actual,
    logAudit: vi.fn(),
    formatTime: vi.fn((input: string | Date, _tz?: string) => ({
      utc: typeof input === 'string' ? input : input.toISOString(),
      local: 'local-stub',
      tz: 'UTC',
    })),
    sessionTimezone: vi.fn(() => 'UTC'),
  };
});

import { registerJournalTools } from '../tools/journal.js';
import { registerMediaTools } from '../tools/media.js';
import { ElasticsearchLocationRepository } from '../repositories/elasticsearch/location.repository.js';
import { ElasticsearchNotableEventRepository } from '../repositories/elasticsearch/notable-event.repository.js';
import { logger } from '../utils/logger.js';
import { captureTools, parseToolResponse, makeMockEsClient } from './_helpers.js';

const OWNER = 'user-owner';
const OTHER = 'user-attacker';

// ===========================================================================
// BUG 1 — ElasticsearchLocationRepository.delete ignores userId + swallows errors
// ===========================================================================
describe('ElasticsearchLocationRepository.delete — user scoping + error handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes the delete by user_id (does not delete by raw _id)', async () => {
    const deleteByQuery = vi.fn().mockResolvedValue({ deleted: 1 });
    const rawDelete = vi.fn().mockResolvedValue({ result: 'deleted' });
    const client = { deleteByQuery, delete: rawDelete } as never;
    const repo = new ElasticsearchLocationRepository(client);

    const result = await repo.delete(OWNER, 'loc-1');

    expect(result).toBe(true);
    // Must NOT use the raw delete-by-id API (which has no user scoping).
    expect(rawDelete).not.toHaveBeenCalled();
    expect(deleteByQuery).toHaveBeenCalledTimes(1);
    const arg = deleteByQuery.mock.calls[0][0];
    // The query must contain BOTH the doc id and the owning user_id.
    const serialized = JSON.stringify(arg);
    expect(serialized).toContain('loc-1');
    expect(serialized).toContain(OWNER);
  });

  it("does not delete another user's point (cross-user denial)", async () => {
    // deleteByQuery scoped to OTHER finds nothing to delete -> 0.
    const deleteByQuery = vi.fn().mockResolvedValue({ deleted: 0 });
    const client = { deleteByQuery, delete: vi.fn() } as never;
    const repo = new ElasticsearchLocationRepository(client);

    const result = await repo.delete(OTHER, 'loc-owned-by-owner');

    expect(result).toBe(false);
    const arg = deleteByQuery.mock.calls[0][0];
    expect(JSON.stringify(arg)).toContain(OTHER);
  });

  it('surfaces real ES errors instead of swallowing them as false', async () => {
    const boom = new Error('elasticsearch unavailable');
    const deleteByQuery = vi.fn().mockRejectedValue(boom);
    const client = { deleteByQuery, delete: vi.fn() } as never;
    const repo = new ElasticsearchLocationRepository(client);

    await expect(repo.delete(OWNER, 'loc-1')).rejects.toThrow('elasticsearch unavailable');
  });
});

// ===========================================================================
// BUG 2 — resolve_journal with entry_id has no user_id ownership guard
// ===========================================================================
describe('resolve_journal tool — entry_id ownership guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves an entry the caller owns", async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    const get = vi.fn().mockResolvedValue({ _id: 'j-1', _source: { user_id: OWNER, status: 'open' } });
    const es = makeMockEsClient({ update, get });
    const tools = captureTools((s) =>
      registerJournalTools(s, es as never, () => OWNER),
    );

    const response = await tools.get('resolve_journal')!({ entry_id: 'j-1' });

    expect(parseToolResponse<{ resolved_count: number }>(response).resolved_count).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses to resolve an entry owned by another user (cross-user denial)", async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    const get = vi.fn().mockResolvedValue({ _id: 'j-1', _source: { user_id: OWNER, status: 'open' } });
    const es = makeMockEsClient({ update, get });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const tools = captureTools((s) =>
      registerJournalTools(s, es as never, () => OTHER),
    );

    const response = await tools.get('resolve_journal')!({ entry_id: 'j-1' });

    // The attacker's resolve must NOT mutate the owner's entry.
    expect(update).not.toHaveBeenCalled();
    expect(parseToolResponse<{ resolved_count: number }>(response).resolved_count).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      'cross_user_access_denied',
      expect.objectContaining({
        actor_user_id: OTHER,
        owner_user_id: OWNER,
        resource: 'journal',
        id: 'j-1',
      }),
    );
    warnSpy.mockRestore();
  });
});

// ===========================================================================
// BUG 3 — queryUnacknowledged drops old high-severity events (in-memory filter)
// ===========================================================================
describe('ElasticsearchNotableEventRepository.queryUnacknowledged — severity at query time', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies min_severity as a query-time filter, not an in-memory post-filter', async () => {
    const search = vi.fn().mockResolvedValue({
      hits: { total: { value: 1 }, hits: [
        { _id: 'ev-old-high', _source: {
          user_id: OWNER, event_type: 'overdue_item', summary: 'old but high',
          severity: 'high', payload: {}, acknowledged: false, created_at: '2020-01-01T00:00:00.000Z',
        } },
      ] },
    });
    const client = { search } as never;
    const repo = new ElasticsearchNotableEventRepository(client);

    const results = await repo.queryUnacknowledged(OWNER, { min_severity: 'high' });

    // The severity constraint must be pushed into the ES query so old
    // high-severity events are not dropped by a size:100 newest-first window.
    const body = JSON.stringify(search.mock.calls[0][0]);
    expect(body).toContain('severity');
    expect(body).toContain('high');
    // And the high-severity event is returned.
    expect(results.map((e) => e.id)).toContain('ev-old-high');
  });

  it('still scopes by user_id', async () => {
    const search = vi.fn().mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });
    const client = { search } as never;
    const repo = new ElasticsearchNotableEventRepository(client);

    await repo.queryUnacknowledged(OWNER, { min_severity: 'medium' });

    expect(JSON.stringify(search.mock.calls[0][0])).toContain(OWNER);
  });
});

// ===========================================================================
// BUG 4 — link_media / unlink_media missing user_id scoping + ownership check
// ===========================================================================
describe('link_media / unlink_media — media ownership + user scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('link_media verifies the media belongs to the caller before linking', async () => {
    const index = vi.fn().mockResolvedValue({ _id: 'link-1', result: 'created' });
    const get = vi.fn().mockResolvedValue({ _id: 'm-1', _source: { user_id: OWNER } });
    const es = makeMockEsClient({ index, get });
    const tools = captureTools((s) => registerMediaTools(s, es as never, () => OWNER));

    const response = await tools.get('link_media')!({
      media_id: 'm-1', entity_type: 'person', entity_id: 'p-7',
    });

    expect(parseToolResponse<{ linked: boolean }>(response).linked).toBe(true);
    expect(index).toHaveBeenCalledTimes(1);
  });

  it("link_media refuses to link media owned by another user (cross-user denial)", async () => {
    const index = vi.fn();
    const get = vi.fn().mockResolvedValue({ _id: 'm-1', _source: { user_id: OWNER } });
    const es = makeMockEsClient({ index, get });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const tools = captureTools((s) => registerMediaTools(s, es as never, () => OTHER));

    const response = await tools.get('link_media')!({
      media_id: 'm-1', entity_type: 'person', entity_id: 'p-7',
    });

    expect(response.isError).toBe(true);
    expect(index).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'cross_user_access_denied',
      expect.objectContaining({
        actor_user_id: OTHER,
        owner_user_id: OWNER,
        resource: 'media',
        id: 'm-1',
      }),
    );
    warnSpy.mockRestore();
  });

  it('unlink_media scopes the delete by user_id (not media_id alone)', async () => {
    const deleteByQuery = vi.fn().mockResolvedValue({ deleted: 1 });
    const rawDelete = vi.fn();
    const es = makeMockEsClient({ deleteByQuery, delete: rawDelete });
    const tools = captureTools((s) => registerMediaTools(s, es as never, () => OWNER));

    await tools.get('unlink_media')!({ media_id: 'm-1', entity_type: 'person', entity_id: 'p-7' });

    // Must scope by user_id; a raw delete-by-id has no user guard.
    expect(rawDelete).not.toHaveBeenCalled();
    expect(deleteByQuery).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(deleteByQuery.mock.calls[0][0]);
    expect(body).toContain(OWNER);
    expect(body).toContain('m-1_person_p-7');
  });

  it('delete_media cleanup scopes the media-link deletion by user_id', async () => {
    const get = vi.fn().mockResolvedValue({ _id: 'm-1', _source: { user_id: OWNER, url: 'u' } });
    const deleteByQuery = vi.fn().mockResolvedValue({ deleted: 2 });
    const rawDelete = vi.fn().mockResolvedValue({ result: 'deleted' });
    const es = makeMockEsClient({ get, deleteByQuery, delete: rawDelete });
    const tools = captureTools((s) => registerMediaTools(s, es as never, () => OWNER));

    await tools.get('delete_media')!({ media_id: 'm-1' });

    const body = JSON.stringify(deleteByQuery.mock.calls[0][0]);
    expect(body).toContain(OWNER);
    expect(body).toContain('m-1');
  });
});
