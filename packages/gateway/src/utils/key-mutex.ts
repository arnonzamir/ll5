import { logger } from './logger.js';

/**
 * In-process per-key async mutex.
 *
 * The gateway is a single-process service, so an in-memory lock is sufficient to
 * serialize read-modify-write sequences that share a logical key (e.g. a per-user
 * location-state doc, or a per-(user::bssid) network doc). Without it, two
 * concurrent webhooks for the same user can interleave a read with another's
 * write — double-firing transition pushes or losing observation counts.
 *
 * Operations for the same key run strictly one-after-another in submission order;
 * operations for different keys run concurrently. Failures don't break the chain:
 * a rejected op still releases the lock for the next waiter.
 */
export class KeyMutex {
  // Each key maps to the tail of its pending promise chain. We chain onto the
  // tail so submissions queue in order; we never store the result, only the
  // settle signal, so the chain can't leak data between callers.
  private chains = new Map<string, Promise<void>>();

  /**
   * Run `fn` exclusively with respect to other `runExclusive` calls for the same
   * `key`. Returns whatever `fn` resolves to (or rejects with its error).
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The next waiter chains onto our gate, not onto fn's result/throw, so an
    // error in fn doesn't poison the chain.
    this.chains.set(key, prev.then(() => gate));

    // Wait for our turn.
    await prev;

    if (this.chains.get(key) !== undefined) {
      logger.debug('[key-mutex][runExclusive] entering critical section', { key });
    }

    try {
      return await fn();
    } finally {
      release();
      // If nobody queued behind us, drop the key to avoid unbounded growth.
      // `prev.then(() => gate)` is the tail we set; if it's still the current
      // tail and already settled, clear it on next tick.
      void Promise.resolve().then(() => {
        const tail = this.chains.get(key);
        if (tail) {
          // Probe whether the tail is settled and no later waiter replaced it.
          tail
            .then(() => {
              if (this.chains.get(key) === tail) this.chains.delete(key);
            })
            .catch(() => {
              if (this.chains.get(key) === tail) this.chains.delete(key);
            });
        }
      });
    }
  }
}

/** Shared process-wide mutex instance for gateway read-modify-write sections. */
export const gatewayKeyMutex = new KeyMutex();
