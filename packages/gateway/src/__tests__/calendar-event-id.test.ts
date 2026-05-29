import { describe, it, expect, vi, beforeEach } from 'vitest';
import { phoneEventId, processCalendar } from '../processors/calendar.js';
import type { Client } from '@elastic/elasticsearch';
import type { PushCalendarItem } from '../types/index.js';

const TITLE = 'Sprint Planning';
const START = '2026-05-29T10:00:00.000Z';
const END = '2026-05-29T11:00:00.000Z';

describe('phoneEventId — per-tenant doc id derivation', () => {
  it('produces DIFFERENT ids for two tenants with an identical title/start/end', () => {
    // Without userId in the hash input, two tenants with the same event collide
    // and overwrite each other in the shared ES index (cross-tenant vector).
    const idA = phoneEventId('user-A', TITLE, START, END);
    const idB = phoneEventId('user-B', TITLE, START, END);

    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^phone-[0-9a-f]{16}$/);
    expect(idB).toMatch(/^phone-[0-9a-f]{16}$/);
  });

  it('is deterministic for the same tenant + event', () => {
    expect(phoneEventId('user-A', TITLE, START, END)).toBe(phoneEventId('user-A', TITLE, START, END));
  });
});

describe('processCalendar — writes the user-scoped deterministic id', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeEsNoOverlap(): Client & { index: ReturnType<typeof vi.fn> } {
    return {
      search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
      index: vi.fn().mockResolvedValue({ _id: 'x', result: 'created' }),
      update: vi.fn().mockResolvedValue({ result: 'updated' }),
    } as unknown as Client & { index: ReturnType<typeof vi.fn> };
  }

  it('indexes the new event under phoneEventId(userId, ...)', async () => {
    const es = makeEsNoOverlap();
    const item = { type: 'calendar_event', title: TITLE, start: START, end: END } as unknown as PushCalendarItem;

    await processCalendar(es, 'user-A', item);

    const call = es.index.mock.calls[0][0] as { id: string };
    expect(call.id).toBe(phoneEventId('user-A', TITLE, START, END));
  });
});
