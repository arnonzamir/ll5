import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processCalendar } from '../processors/calendar.js';
import type { Client } from '@elastic/elasticsearch';
import type { PushCalendarItem } from '../types/index.js';

const USER_ID = 'user-cal-1';

/**
 * ES client whose search returns one overlapping Google event with a generic
 * title (so processCalendar takes the enrich/merge branch) and records every
 * update() call so the test can assert what was written.
 */
function makeEsClientWithGenericGoogleEvent(existing: {
  title?: string;
  location?: string;
  description?: string;
}): Client {
  return {
    search: vi.fn().mockResolvedValue({
      hits: {
        hits: [
          {
            _id: 'google-evt-1',
            _source: {
              source: 'google',
              title: existing.title,
              location: existing.location,
              description: existing.description,
              start_time: '2026-05-29T10:00:00.000Z',
              end_time: '2026-05-29T11:00:00.000Z',
            },
          },
        ],
      },
    }),
    update: vi.fn().mockResolvedValue({ result: 'updated' }),
    index: vi.fn().mockResolvedValue({ _id: 'doc-1', result: 'created' }),
  } as unknown as Client;
}

function makeItem(overrides: Partial<PushCalendarItem> = {}): PushCalendarItem {
  return {
    title: 'Sprint Planning',
    start: '2026-05-29T10:00:00.000Z',
    end: '2026-05-29T11:00:00.000Z',
    ...overrides,
  } as PushCalendarItem;
}

describe('processCalendar — merge location fallback (bug #4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT write the existing title into location when the push has no location', async () => {
    // Google event has a generic title ('(no title)') and a real location.
    // Phone push supplies the real title but NO location.
    const es = makeEsClientWithGenericGoogleEvent({
      title: '(no title)',
      location: 'Conference Room B',
    });

    await processCalendar(es, USER_ID, makeItem({ location: undefined }));

    expect(es.update).toHaveBeenCalledTimes(1);
    const updateArg = (es.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // BUG: code falls back to existing.title ('(no title)') instead of
    // existing.location ('Conference Room B'). The push title must NEVER end
    // up in the location field.
    expect(updateArg.doc.location).not.toBe('(no title)');
    expect(updateArg.doc.location).not.toBe(updateArg.doc.title);
    expect(updateArg.doc.location).toBe('Conference Room B');
  });

  it('preserves the existing location when push has none and emits location_source:existing', async () => {
    const es = makeEsClientWithGenericGoogleEvent({
      title: 'busy',
      location: 'Tel Aviv Office',
    });

    await processCalendar(es, USER_ID, makeItem({ location: undefined }));

    const updateArg = (es.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArg.doc.location).toBe('Tel Aviv Office');
  });

  it('uses the push location when supplied (location_source:push)', async () => {
    const es = makeEsClientWithGenericGoogleEvent({
      title: '(no title)',
      location: 'Old Place',
    });

    await processCalendar(es, USER_ID, makeItem({ location: 'New Place' }));

    const updateArg = (es.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArg.doc.location).toBe('New Place');
  });

  it('scopes the overlap search to the calling user_id', async () => {
    const es = makeEsClientWithGenericGoogleEvent({ title: '(no title)', location: 'X' });
    await processCalendar(es, USER_ID, makeItem());

    const searchArg = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const filters = searchArg.query.bool.filter as Array<Record<string, unknown>>;
    const userTerm = filters.find((f) => 'term' in f && (f.term as Record<string, unknown>).user_id);
    expect(userTerm).toBeDefined();
    expect((userTerm!.term as Record<string, string>).user_id).toBe(USER_ID);
  });
});
