import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = join(__dirname, '..', 'migrations');

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    logger.warn('[MigrationRunner][runMigrations] No migrations directory found, skipping migrations', { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (files.length === 0) {
    logger.info('[MigrationRunner][runMigrations] No migration files found');
    return;
  }

  for (const file of files) {
    const filePath = join(migrationsDir, file);
    const sql = readFileSync(filePath, 'utf-8');

    logger.info(`[MigrationRunner][runMigrations] Running migration: ${file}`);
    try {
      await pool.query(sql);
      logger.info(`[MigrationRunner][runMigrations] Migration completed: ${file}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[MigrationRunner][runMigrations] Migration failed: ${file}`, { error: message });
      throw err;
    }
  }

  logger.info(`[MigrationRunner][runMigrations] All migrations completed (${files.length} files)`);
}
