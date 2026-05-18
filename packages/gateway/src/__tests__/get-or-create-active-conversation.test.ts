import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { getOrCreateActiveConversation } from '../chat.js';

const USER_ID = 'user-test';

/**
 * Tests the 23505 retry loop in getOrCreateActiveConversation.
 *
 * Why this matters: under concurrent writes, two requests can race past the
 * SELECT and both try to INSERT. The unique partial index rejects one of them
 * with 23505. The loser must retry the SELECT and find the winner's row —
 * but read-committed isolation means the winner's row may not be visible on
 * the first retry, hence the bounded loop with linear backoff.
 *
 * We drive this with a programmable fake Pool that queues responses for each
 * .query() call in order. No real Postgres needed; the contract we're
 * verifying is "given pg returns 23505 on INSERT, the function retries".
 */
type QueuedResponse =
  | { kind: 'rows'; rows: Array<{ conversation_id: string }> }
  | { kind: 'throw'; error: Error & { code?: string } };

function makeProgrammablePool(queue: QueuedResponse[]): {
  pool: Pool;
  callLog: Array<{ sql: string; params: unknown[] }>;
} {
  const callLog: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    callLog.push({ sql, params });
    const next = queue.shift();
    if (!next) throw new Error(`No queued response for query: ${sql.slice(0, 60)}`);
    if (next.kind === 'throw') throw next.error;
    return { rows: next.rows, rowCount: next.rows.length } as QueryResult;
  });
  return { pool: { query } as unknown as Pool, callLog };
}

function uniqueViolation(): Error & { code: string } {
  const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  err.code = '23505';
  return err;
}

describe('getOrCreateActiveConversation', () => {
  it('returns the existing conversation id when one is active (no insert)', async () => {
    const { pool, callLog } = makeProgrammablePool([
      { kind: 'rows', rows: [{ conversation_id: 'conv-existing' }] },
    ]);

    const id = await getOrCreateActiveConversation(pool, USER_ID);

    expect(id).toBe('conv-existing');
    expect(callLog).toHaveLength(1);
    expect(callLog[0].sql).toMatch(/SELECT conversation_id FROM chat_conversations/);
    expect(callLog[0].params).toEqual([USER_ID]);
  });

  it('inserts a new conversation when none exists', async () => {
    const { pool, callLog } = makeProgrammablePool([
      { kind: 'rows', rows: [] },
      { kind: 'rows', rows: [{ conversation_id: 'conv-new' }] },
    ]);

    const id = await getOrCreateActiveConversation(pool, USER_ID);

    expect(id).toBe('conv-new');
    expect(callLog).toHaveLength(2);
    expect(callLog[0].sql).toMatch(/SELECT conversation_id/);
    expect(callLog[1].sql).toMatch(/INSERT INTO chat_conversations/);
    expect(callLog[1].params).toEqual([USER_ID]);
  });

  it('retries SELECT on 23505 and returns the winner row on next attempt', async () => {
    const { pool, callLog } = makeProgrammablePool([
      { kind: 'rows', rows: [] },
      { kind: 'throw', error: uniqueViolation() },
      { kind: 'rows', rows: [{ conversation_id: 'conv-winner' }] },
    ]);

    const id = await getOrCreateActiveConversation(pool, USER_ID);

    expect(id).toBe('conv-winner');
    expect(callLog).toHaveLength(3);
    expect(callLog[0].sql).toMatch(/SELECT/);
    expect(callLog[1].sql).toMatch(/INSERT/);
    expect(callLog[2].sql).toMatch(/SELECT/);
  });

  it('survives two consecutive 23505s and recovers on the third attempt', async () => {
    const { pool, callLog } = makeProgrammablePool([
      // attempt 0
      { kind: 'rows', rows: [] },
      { kind: 'throw', error: uniqueViolation() },
      // attempt 1: re-SELECT still sees no committed row (winner not COMMITted yet)
      { kind: 'rows', rows: [] },
      { kind: 'throw', error: uniqueViolation() },
      // attempt 2: finally see the winner
      { kind: 'rows', rows: [{ conversation_id: 'conv-winner-final' }] },
    ]);

    const id = await getOrCreateActiveConversation(pool, USER_ID);

    expect(id).toBe('conv-winner-final');
    expect(callLog).toHaveLength(5);
  });

  it('propagates the original 23505 on the final attempt (no further retries)', async () => {
    // On attempt=2 (third try), the retry guard `attempt < MAX_ATTEMPTS - 1`
    // is false, so the 23505 error itself is rethrown rather than swallowed
    // into an "exhausted" wrapper.
    const finalErr = uniqueViolation();
    const { pool } = makeProgrammablePool([
      { kind: 'rows', rows: [] },
      { kind: 'throw', error: uniqueViolation() },
      { kind: 'rows', rows: [] },
      { kind: 'throw', error: uniqueViolation() },
      { kind: 'rows', rows: [] },
      { kind: 'throw', error: finalErr },
    ]);

    await expect(getOrCreateActiveConversation(pool, USER_ID))
      .rejects.toThrow(/duplicate key value/);
  });

  it('propagates non-23505 errors immediately (no retry)', async () => {
    const otherErr = new Error('connection terminated') as Error & { code: string };
    otherErr.code = '08006';

    const { pool, callLog } = makeProgrammablePool([
      { kind: 'rows', rows: [] },
      { kind: 'throw', error: otherErr },
    ]);

    await expect(getOrCreateActiveConversation(pool, USER_ID)).rejects.toThrow('connection terminated');
    expect(callLog).toHaveLength(2);
  });

  it('always scopes the SELECT by user_id', async () => {
    const { pool, callLog } = makeProgrammablePool([
      { kind: 'rows', rows: [{ conversation_id: 'c' }] },
    ]);

    await getOrCreateActiveConversation(pool, 'specific-user');

    expect(callLog[0].sql).toMatch(/WHERE user_id = \$1/);
    expect(callLog[0].params).toEqual(['specific-user']);
  });

  it('always scopes the INSERT by user_id', async () => {
    const { pool, callLog } = makeProgrammablePool([
      { kind: 'rows', rows: [] },
      { kind: 'rows', rows: [{ conversation_id: 'c-new' }] },
    ]);

    await getOrCreateActiveConversation(pool, 'specific-user');

    expect(callLog[1].sql).toMatch(/INSERT INTO chat_conversations/);
    expect(callLog[1].params).toEqual(['specific-user']);
  });
});
