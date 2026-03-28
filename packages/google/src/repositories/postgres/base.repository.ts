import type { Pool, QueryResult } from 'pg';

export class BasePostgresRepository {
  constructor(protected pool: Pool) {}

  protected async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result: QueryResult = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  protected async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
}
