// Per-scheduler health registry. Before this, every scheduler caught+warned
// at tick() level with no counter — so a silently-throwing scheduler could go
// dark indefinitely. The Apr 19–21 outage hid through a logger.warn exactly
// this way. With this registry, /admin/health.schedulers surfaces last_ok_at,
// last_error_at, and the consecutive-failure count for every scheduler.

import { logger } from './logger.js';

export interface SchedulerHealthEntry {
  name: string;
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  total_ticks: number;
  total_failures: number;
  consecutive_failures: number;
}

const entries = new Map<string, SchedulerHealthEntry>();

function ensure(name: string): SchedulerHealthEntry {
  let e = entries.get(name);
  if (!e) {
    e = {
      name,
      last_ok_at: null,
      last_error_at: null,
      last_error: null,
      last_error_code: null,
      total_ticks: 0,
      total_failures: 0,
      consecutive_failures: 0,
    };
    entries.set(name, e);
  }
  return e;
}

export function recordTickOk(name: string): void {
  const e = ensure(name);
  e.total_ticks += 1;
  e.consecutive_failures = 0;
  e.last_ok_at = new Date().toISOString();
}

export function recordTickError(name: string, err: unknown): void {
  const e = ensure(name);
  e.total_ticks += 1;
  e.total_failures += 1;
  e.consecutive_failures += 1;
  e.last_error_at = new Date().toISOString();
  e.last_error = err instanceof Error ? err.message : String(err);
  e.last_error_code = (err as { code?: string } | null)?.code ?? null;
}

export function getSchedulerHealthSnapshot(): SchedulerHealthEntry[] {
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Wrap a tick body. Records ok on clean exit, error on throw, and
 *  logs at error level so the failure is visible to log explorers.
 *  Re-throws — the scheduler's own try/catch decides whether to swallow. */
export async function withSchedulerHealth<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    recordTickOk(name);
    return result;
  } catch (err) {
    recordTickError(name, err);
    const e = entries.get(name)!;
    logger.error(`[scheduler][${name}] tick failed`, {
      error: e.last_error,
      error_code: e.last_error_code,
      consecutive_failures: e.consecutive_failures,
      total_failures: e.total_failures,
    });
    throw err;
  }
}
