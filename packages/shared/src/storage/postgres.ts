import pg from 'pg';

const { Pool } = pg;

export type PostgresPool = pg.Pool;

export interface PostgresConfig {
  databaseUrl: string;
  maxConnections?: number;
}

export function createPostgresPool(config: PostgresConfig): PostgresPool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.maxConnections ?? 10,
  });
}

export async function withUserScope(
  pool: PostgresPool,
  userId: string,
  fn: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL app.current_user_id = '${userId}'`);
    await fn(client);
  } finally {
    client.release();
  }
}
