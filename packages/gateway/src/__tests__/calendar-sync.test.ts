import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarSyncScheduler } from '../scheduler/calendar-sync.js';
import type { Client } from '@elastic/elasticsearch';
import type { GoogleCalendarClient } from '../scheduler/google-calendar-client.js';

const USER_ID = 'user-sync-1';

function makeGoogleClient(events: unknown[]): GoogleCalendarClient {
  return {
    getEvents: vi.fn().mockResolvedValue(events),
  } as unknown as GoogleCalendarClient;
}

function makeEs(): Client & { bulk: ReturnType<typeof vi.fn> } {
  return {
    bulk: vi.fn().mockResolvedValue({ errors: false, items: [] }),
  } as unknown as Client & { bulk: ReturnType<typeof vi.fn> };
}

function sampleEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-1',
    calendar_id: 'cal-1',
    calendar_name: 'Work',
    calendar_color: '#fff',
    title: 'Sprint Planning',
    start: '2026-05-29T10:00:00.000Z',
    end: '2026-05-29T11:00:00.000Z',
    all_day: false,
    location: 'Room A',
    description: 'desc',
    attendees: [],
    html_link: 'http://x',
    status: 'confirmed',
    recurring: false,
    ...overrides,
  };
}

/** Flatten a bulk operations array into [action, body] pairs. */
function bulkPairs(operations: unknown[]): Array<{ action: Record<string, unknown>; body: Record<string, unknown> }> {
  const pairs: Array<{ action: Record<string, unknown>; body: Record<string, unknown> }> = [];
  for (let i = 0; i < operations.length; i += 2) {
    pairs.push({
      action: operations[i] as Record<string, unknown>,
      body: operations[i + 1] as Record<string, unknown>,
    });
  }
  return pairs;
}

describe('CalendarSyncScheduler — non-destructive sync (bug #5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT use a full doc-replace index op that resets created_at', async () => {
    const es = makeEs();
    const scheduler = new CalendarSyncScheduler(es, makeGoogleClient([sampleEvent()]), USER_ID);

    await scheduler.sync();

    expect(es.bulk).toHaveBeenCalledTimes(1);
    const ops = (es.bulk.mock.calls[0][0] as { operations: unknown[] }).operations;
    const pairs = bulkPairs(ops);

    // BUG: scheduler emits { index: ... } which fully replaces the doc, wiping
    // created_at back to now and reverting any merged enrichment. A partial
    // update/upsert must be used instead.
    const hasIndexReplace = pairs.some((p) => 'index' in p.action);
    expect(hasIndexReplace).toBe(false);

    const hasUpdate = pairs.some((p) => 'update' in p.action);
    expect(hasUpdate).toBe(true);
  });

  it('does not send created_at in the partial doc (so existing created_at is preserved)', async () => {
    const es = makeEs();
    const scheduler = new CalendarSyncScheduler(es, makeGoogleClient([sampleEvent()]), USER_ID);

    await scheduler.sync();

    const ops = (es.bulk.mock.calls[0][0] as { operations: unknown[] }).operations;
    const pairs = bulkPairs(ops);
    const updatePair = pairs.find((p) => 'update' in p.action);
    expect(updatePair).toBeDefined();

    // The update body holds { doc, upsert }. The partial doc must not clobber
    // created_at on an existing merged doc.
    const doc = updatePair!.body.doc as Record<string, unknown>;
    expect(doc).toBeDefined();
    expect(doc.created_at).toBeUndefined();
    // created_at only appears in the upsert (insert-only) branch.
    const upsert = updatePair!.body.upsert as Record<string, unknown>;
    expect(upsert).toBeDefined();
    expect(upsert.created_at).toBeDefined();
  });

  it('does not clobber a merged title/location: partial doc must not overwrite source=merged enrichment', async () => {
    const es = makeEs();
    const scheduler = new CalendarSyncScheduler(es, makeGoogleClient([sampleEvent()]), USER_ID);

    await scheduler.sync();

    const ops = (es.bulk.mock.calls[0][0] as { operations: unknown[] }).operations;
    const updatePair = bulkPairs(ops).find((p) => 'update' in p.action)!;
    const doc = updatePair.body.doc as Record<string, unknown>;

    // The partial doc must NOT force source back to 'google' on an already
    // merged doc, and must not blow away the enriched title/location. The
    // sync's own title/location belong only in the upsert (new-doc) branch.
    expect(doc.source).toBeUndefined();
    expect(doc.title).toBeUndefined();
  });

  it('scopes every synced doc to the configured user_id', async () => {
    const es = makeEs();
    const scheduler = new CalendarSyncScheduler(es, makeGoogleClient([sampleEvent()]), USER_ID);

    await scheduler.sync();

    const ops = (es.bulk.mock.calls[0][0] as { operations: unknown[] }).operations;
    const updatePair = bulkPairs(ops).find((p) => 'update' in p.action)!;
    const upsert = updatePair.body.upsert as Record<string, unknown>;
    expect(upsert.user_id).toBe(USER_ID);
  });
});
