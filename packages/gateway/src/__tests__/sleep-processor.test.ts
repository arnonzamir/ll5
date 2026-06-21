import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { PushSleepSegmentItem, PushSleepClassifyItem } from '../types/index.js';
import { processSleepSegment, processSleepClassify } from '../processors/sleep.js';

const USER = 'user-sleep-1';

interface IndexCall { index: string; document: Record<string, unknown> }

function makeEs(): { es: Client; indexed: IndexCall[] } {
  const indexed: IndexCall[] = [];
  const es = {
    index: vi.fn(async (req: { index: string; document: Record<string, unknown> }) => {
      indexed.push({ index: req.index, document: req.document });
      return { result: 'created' };
    }),
  } as unknown as Client;
  return { es, indexed };
}

function sleepDocs(indexed: IndexCall[]): Record<string, unknown>[] {
  return indexed.filter((c) => c.index === 'll5_awareness_sleep').map((c) => c.document);
}
function notableEvents(indexed: IndexCall[]): Record<string, unknown>[] {
  return indexed.filter((c) => c.index === 'll5_awareness_notable_events').map((c) => c.document);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processSleepSegment', () => {
  it('stores a SUCCESS segment AND writes a sleep_summary notable event', async () => {
    const { es, indexed } = makeEs();
    const item: PushSleepSegmentItem = {
      type: 'sleep_segment',
      start: '2026-06-21T00:10:00.000Z',
      end: '2026-06-21T07:05:00.000Z',
      duration_min: 415,
      status: 'SUCCESS',
      timestamp: '2026-06-21T07:06:00.000Z',
    };
    await processSleepSegment(es, USER, item);

    const docs = sleepDocs(indexed);
    expect(docs).toHaveLength(1);
    expect(docs[0].kind).toBe('segment');
    expect(docs[0].status).toBe('SUCCESS');
    expect(docs[0].duration_min).toBe(415);

    const events = notableEvents(indexed);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('sleep_summary');
    expect(String(events[0].summary)).toMatch(/Slept ~6h 55m/);
  });

  it('stores a non-SUCCESS segment WITHOUT a notable event', async () => {
    const { es, indexed } = makeEs();
    const item: PushSleepSegmentItem = {
      type: 'sleep_segment',
      start: '2026-06-21T00:10:00.000Z',
      end: '2026-06-21T07:05:00.000Z',
      duration_min: 0,
      status: 'MISSING_DATA',
      timestamp: '2026-06-21T07:06:00.000Z',
    };
    await processSleepSegment(es, USER, item);

    expect(sleepDocs(indexed)).toHaveLength(1);
    expect(notableEvents(indexed)).toHaveLength(0);
  });
});

describe('processSleepClassify', () => {
  it('stores a classify reading under kind:classify with motion_level', async () => {
    const { es, indexed } = makeEs();
    const item: PushSleepClassifyItem = {
      type: 'sleep_classify',
      confidence: 80,
      light: 3,
      motion_level: 1,
      timestamp: '2026-06-21T02:00:00.000Z',
    };
    await processSleepClassify(es, USER, item);

    const docs = sleepDocs(indexed);
    expect(docs).toHaveLength(1);
    expect(docs[0].kind).toBe('classify');
    expect(docs[0].motion_level).toBe(1);
    expect(docs[0].confidence).toBe(80);
    expect(notableEvents(indexed)).toHaveLength(0);
  });
});
