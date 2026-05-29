import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { ESCalendarEventRepository } from '../repositories/elasticsearch/calendar-event.repository.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const INDEX = 'll5_awareness_calendar_events';
const USER_A = 'user-aaa';
const USER_B = 'user-bbb';
const SHARED_EVENT_ID = 'evt-shared-123';

function makeMockEs(): { es: Client; index: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } {
  const index = vi.fn().mockResolvedValue({});
  const del = vi.fn().mockResolvedValue({});
  const es = { index, delete: del, search: vi.fn() } as unknown as Client;
  return { es, index, del };
}

function googleEvent(eventId: string) {
  return {
    event_id: eventId,
    calendar_id: 'primary',
    calendar_name: 'Cal',
    title: 'T',
    start: '2026-04-06T10:00:00Z',
    end: '2026-04-06T11:00:00Z',
    all_day: false,
  };
}

describe('ESCalendarEventRepository — per-user doc id isolation', () => {
  it('two users with the SAME google event_id write to DISTINCT doc ids (no overwrite)', async () => {
    const { es, index } = makeMockEs();
    const repo = new ESCalendarEventRepository(es);

    await repo.upsertFromGoogle(USER_A, googleEvent(SHARED_EVENT_ID));
    await repo.upsertFromGoogle(USER_B, googleEvent(SHARED_EVENT_ID));

    const idA = (index.mock.calls[0][0] as { id: string }).id;
    const idB = (index.mock.calls[1][0] as { id: string }).id;

    expect(idA).not.toBe(idB);
    // each id must be namespaced by its own user
    expect(idA).toContain(USER_A);
    expect(idB).toContain(USER_B);
    expect(idA).toContain(SHARED_EVENT_ID);
  });

  it('deleting user A\'s event does NOT touch user B\'s doc id', async () => {
    const { es, index, del } = makeMockEs();
    const repo = new ESCalendarEventRepository(es);

    await repo.upsertFromGoogle(USER_A, googleEvent(SHARED_EVENT_ID));
    await repo.upsertFromGoogle(USER_B, googleEvent(SHARED_EVENT_ID));
    const idB = (index.mock.calls[1][0] as { id: string }).id;

    await repo.deleteForUser(USER_A, SHARED_EVENT_ID, false);

    const deletedIds = del.mock.calls.map((c) => (c[0] as { id: string }).id);
    // user B's current scoped doc must never be among the deleted ids
    expect(deletedIds).not.toContain(idB);
    // user A's scoped doc must be deleted
    const idA = (index.mock.calls[0][0] as { id: string }).id;
    expect(deletedIds).toContain(idA);
    // index used is correct
    expect((del.mock.calls[0][0] as { index: string }).index).toBe(INDEX);
  });

  it('deleteForUser also clears the legacy (unscoped) doc id for migration safety', async () => {
    const { es, del } = makeMockEs();
    const repo = new ESCalendarEventRepository(es);

    await repo.deleteForUser(USER_A, SHARED_EVENT_ID, false);

    const deletedIds = del.mock.calls.map((c) => (c[0] as { id: string }).id);
    // legacy id (pre-migration scheme) must still be cleaned up
    expect(deletedIds).toContain(`google-${SHARED_EVENT_ID}`);
  });

  it('tickler doc ids are also user-scoped', async () => {
    const { es, index } = makeMockEs();
    const repo = new ESCalendarEventRepository(es);

    await repo.upsertFromGoogle(USER_A, googleEvent(SHARED_EVENT_ID), true);

    const id = (index.mock.calls[0][0] as { id: string }).id;
    expect(id).toContain(USER_A);
    expect(id).toContain('tickler-');
  });
});
