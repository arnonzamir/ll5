import { describe, it, expect } from 'vitest';
import { KeyMutex } from '../utils/key-mutex.js';

describe('KeyMutex — in-process per-key serialization (G5)', () => {
  it('serializes operations for the same key (no interleaving)', async () => {
    const mutex = new KeyMutex();
    const log: string[] = [];

    const op = (id: string) =>
      mutex.runExclusive('k', async () => {
        log.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, 10));
        log.push(`end-${id}`);
      });

    await Promise.all([op('a'), op('b'), op('c')]);

    // Each op must fully finish before the next starts.
    expect(log).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
  });

  it('runs operations for different keys concurrently', async () => {
    const mutex = new KeyMutex();
    const log: string[] = [];

    const op = (key: string, id: string) =>
      mutex.runExclusive(key, async () => {
        log.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, 10));
        log.push(`end-${id}`);
      });

    await Promise.all([op('k1', 'a'), op('k2', 'b')]);

    // Both start before either ends → concurrent.
    expect(log.slice(0, 2).sort()).toEqual(['start-a', 'start-b']);
  });

  it('does not poison the chain when one op throws', async () => {
    const mutex = new KeyMutex();
    const log: string[] = [];

    const bad = mutex.runExclusive('k', async () => {
      log.push('bad');
      throw new Error('boom');
    });
    const good = mutex.runExclusive('k', async () => {
      log.push('good');
    });

    await expect(bad).rejects.toThrow('boom');
    await good; // must still run
    expect(log).toEqual(['bad', 'good']);
  });

  it('returns the value the operation resolves to', async () => {
    const mutex = new KeyMutex();
    const v = await mutex.runExclusive('k', async () => 42);
    expect(v).toBe(42);
  });

  it('two interleaved transition-style read-modify-writes do not double-fire', async () => {
    // Simulates detectPlaceTransition: read counter, if 0 "push" then write 1.
    // Without the mutex both reads see 0 and both push. With it, only one pushes.
    const mutex = new KeyMutex();
    let stored = 0;
    let pushes = 0;

    const transition = () =>
      mutex.runExclusive('user-1', async () => {
        const read = stored;
        await new Promise((r) => setTimeout(r, 5)); // window for a race
        if (read === 0) {
          pushes += 1;
          stored = 1;
        }
      });

    await Promise.all([transition(), transition()]);
    expect(pushes).toBe(1);
    expect(stored).toBe(1);
  });
});
