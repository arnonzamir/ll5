import type { Pool, QueryResult } from 'pg';
import { vi } from 'vitest';

export interface CapturedQuery {
  text: string;
  values: unknown[];
}

type Responder = (text: string, values: unknown[]) => unknown[] | undefined;

/**
 * A scriptable mock pg.Pool. `responder` returns the rows for a given query
 * (matched on SQL text), or undefined for no rows. All queries are recorded in
 * `calls` so tests can assert on the SQL + params (and prove user_id scoping).
 */
export function makeMockPool(responder: Responder = () => undefined): {
  pool: Pool;
  calls: CapturedQuery[];
} {
  const calls: CapturedQuery[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const rows = responder(text, values) ?? [];
    return { rows, rowCount: rows.length } as unknown as QueryResult;
  });
  const pool = { query } as unknown as Pool;
  return { pool, calls };
}
