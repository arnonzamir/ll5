import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';

import { MessageBatchReviewScheduler } from '../scheduler/message-batch-review.js';
import * as openLoopsModule from '../open-loops.js';
import * as systemMessage from '../utils/system-message.js';
import type { OpenLoops } from '../open-loops.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';
const OTHER_USER = '00000000-0000-0000-0000-000000000000';

/** Fake ES returning a fixed set of unprocessed message hits, and a no-op bulk. */
function fakeES(hits: Array<{ _id: string; _source: Record<string, unknown> }>): Client {
  return {
    search: vi.fn(async () => ({ hits: { hits } })),
    bulk: vi.fn(async () => ({})),
  } as unknown as Client;
}

const HITS = [
  { _id: 'm1', _source: { sender: 'Dana', app: 'whatsapp', content: 'hey', conversation_id: 'c1', timestamp: '2026-07-07T10:00:00Z' } },
];

function mkScheduler(es: Client, pool: Pool, userId = USER): MessageBatchReviewScheduler {
  return new MessageBatchReviewScheduler(es, pool, {
    intervalMinutes: 10,
    startHour: 0,
    endHour: 24,
    timezone: 'UTC',
    userId,
  });
}

const tick = (s: MessageBatchReviewScheduler) =>
  (s as unknown as { tick: () => Promise<void> }).tick();

/** Capture the content string passed to insertSystemMessage. */
function captureInsert(): { getContent: () => string; getUserId: () => string } {
  let content = '';
  let userId = '';
  vi.spyOn(systemMessage, 'insertSystemMessage').mockImplementation(
    async (_pool, uid, c) => {
      userId = uid;
      content = c;
      return 'msg-id';
    },
  );
  return { getContent: () => content, getUserId: () => userId };
}

const emptyLoops: OpenLoops = { waiting_fors: [], next_actions: [], projects: [] };

const dummyPool = { query: vi.fn() } as unknown as Pool;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('MessageBatchReviewScheduler — open-loops embed (DECISION-025 B5)', () => {
  it('embeds a capped open-loops section when getOpenLoops returns loops', async () => {
    const cap = captureInsert();
    vi.spyOn(openLoopsModule, 'getOpenLoops').mockResolvedValue({
      waiting_fors: [
        { id: 'w1', title: 'Moti payment', waiting_for: 'Moti', due_date: '2026-07-10', created_at: 't' },
        { id: 'w2', title: 'Book review', waiting_for: 'Dana', due_date: null, created_at: 't' },
      ],
      next_actions: [{ id: 'n1', title: 'Book flights', due_date: null }],
      projects: [{ id: 'p1', title: 'Green belt', due_date: null }],
    });

    await tick(mkScheduler(fakeES(HITS), dummyPool));

    const content = cap.getContent();
    // Regular batch content still present.
    expect(content).toContain('[Message Batch Review]');
    // Open-loops header + waiting-fors rendered.
    expect(content).toContain('[Open loops]');
    expect(content).toContain('Moti payment');
    expect(content).toContain('waiting on Moti');
    expect(content).toContain('(due 2026-07-10)');
    expect(content).toContain('Book review');
    // Tail context.
    expect(content).toContain('Next actions: Book flights');
    expect(content).toContain('Projects: Green belt');
    // Under the cap → no overflow marker.
    expect(content).not.toContain('more waiting-fors');
  });

  it('caps waiting-fors and shows an overflow marker when over the cap', async () => {
    const cap = captureInsert();
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `w${i}`,
      title: `WF ${i}`,
      waiting_for: `Person ${i}`,
      due_date: null,
      created_at: 't',
    }));
    vi.spyOn(openLoopsModule, 'getOpenLoops').mockResolvedValue({
      waiting_fors: many,
      next_actions: [],
      projects: [],
    });

    await tick(mkScheduler(fakeES(HITS), dummyPool));
    const content = cap.getContent();

    // Only the first 5 titles rendered.
    expect(content).toContain('WF 0');
    expect(content).toContain('WF 4');
    expect(content).not.toContain('WF 5');
    // Overflow indicator for the remaining 3.
    expect(content).toContain('+3 more waiting-fors');
  });

  it('omits the section entirely (no empty header) when there are no loops', async () => {
    const cap = captureInsert();
    vi.spyOn(openLoopsModule, 'getOpenLoops').mockResolvedValue(emptyLoops);

    await tick(mkScheduler(fakeES(HITS), dummyPool));
    const content = cap.getContent();

    expect(content).toContain('[Message Batch Review]');
    expect(content).not.toContain('[Open loops]');
  });

  it('is best-effort: getOpenLoops throwing does not break the batch and omits the section', async () => {
    const cap = captureInsert();
    vi.spyOn(openLoopsModule, 'getOpenLoops').mockRejectedValue(new Error('boom'));

    // Must not throw.
    await expect(tick(mkScheduler(fakeES(HITS), dummyPool))).resolves.toBeUndefined();

    const content = cap.getContent();
    // Batch summary still produced, without an open-loops section.
    expect(content).toContain('[Message Batch Review]');
    expect(content).not.toContain('[Open loops]');
  });

  it('calls getOpenLoops with the batch userId (never a cross-tenant id)', async () => {
    captureInsert();
    const spy = vi.spyOn(openLoopsModule, 'getOpenLoops').mockResolvedValue(emptyLoops);

    await tick(mkScheduler(fakeES(HITS), dummyPool, USER));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(USER);
    expect(spy.mock.calls[0][1]).not.toBe(OTHER_USER);
  });

  it('does not regress the existing batch content (thread grouping + read_messages hint)', async () => {
    const cap = captureInsert();
    vi.spyOn(openLoopsModule, 'getOpenLoops').mockResolvedValue(emptyLoops);

    await tick(mkScheduler(fakeES(HITS), dummyPool));
    const content = cap.getContent();

    expect(content).toContain('Dana (whatsapp)');
    expect(content).toContain('first: "hey"');
    expect(content).toContain('Use read_messages with the platform + conversation_id');
  });
});
