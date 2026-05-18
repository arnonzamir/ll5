import { describe, it, expect } from 'vitest';
import {
  HealthClientRegistry,
  registry as defaultRegistry,
  registerAdapter,
  getAdapter,
  listAdapters,
} from '../clients/registry.js';
import { makeMockAdapter } from './_helpers.js';
import type { HealthSourceAdapter } from '../clients/adapter.js';

function makeAdapterWithId(sourceId: string, displayName = sourceId): HealthSourceAdapter {
  return makeMockAdapter({ sourceId, displayName });
}

// ---------------------------------------------------------------------------
// Per-instance semantics
// ---------------------------------------------------------------------------

describe('HealthClientRegistry', () => {
  describe('register / get / list', () => {
    it('returns undefined for an unregistered sourceId', () => {
      const r = new HealthClientRegistry();
      expect(r.get('garmin')).toBeUndefined();
    });

    it('returns the same adapter instance that was registered', () => {
      const r = new HealthClientRegistry();
      const a = makeAdapterWithId('garmin');
      r.register(a);
      expect(r.get('garmin')).toBe(a);
    });

    it('overwrites on re-register with the same sourceId', () => {
      const r = new HealthClientRegistry();
      const a1 = makeAdapterWithId('garmin', 'Garmin v1');
      const a2 = makeAdapterWithId('garmin', 'Garmin v2');
      r.register(a1);
      r.register(a2);
      expect(r.get('garmin')).toBe(a2);
      expect(r.list()).toHaveLength(1);
    });

    it('list() returns all registered adapters', () => {
      const r = new HealthClientRegistry();
      r.register(makeAdapterWithId('garmin'));
      r.register(makeAdapterWithId('fitbit'));
      r.register(makeAdapterWithId('whoop'));

      const ids = r.list().map((a) => a.sourceId).sort();
      expect(ids).toEqual(['fitbit', 'garmin', 'whoop']);
    });

    it('list() on a fresh instance is empty', () => {
      expect(new HealthClientRegistry().list()).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes all adapters', () => {
      const r = new HealthClientRegistry();
      r.register(makeAdapterWithId('garmin'));
      r.register(makeAdapterWithId('fitbit'));
      r.clear();
      expect(r.list()).toEqual([]);
      expect(r.get('garmin')).toBeUndefined();
    });
  });

  describe('isolation', () => {
    it('two HealthClientRegistry instances do not share state', () => {
      const r1 = new HealthClientRegistry();
      const r2 = new HealthClientRegistry();
      r1.register(makeAdapterWithId('garmin'));
      r2.register(makeAdapterWithId('fitbit'));

      expect(r1.get('garmin')).toBeDefined();
      expect(r1.get('fitbit')).toBeUndefined();
      expect(r2.get('garmin')).toBeUndefined();
      expect(r2.get('fitbit')).toBeDefined();
    });

    it('clearing one instance does not affect the other', () => {
      const r1 = new HealthClientRegistry();
      const r2 = new HealthClientRegistry();
      r1.register(makeAdapterWithId('garmin'));
      r2.register(makeAdapterWithId('garmin'));

      r1.clear();

      expect(r1.get('garmin')).toBeUndefined();
      expect(r2.get('garmin')).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Back-compat function shims must operate on the default instance.
// ---------------------------------------------------------------------------

describe('registry default-instance shims', () => {
  it('registerAdapter / getAdapter / listAdapters operate on the same instance', () => {
    // Snapshot existing adapters so we restore the default registry state at
    // the end — other test files (and module init) may have registered into it.
    const before = defaultRegistry.list();

    const adapter = makeAdapterWithId('test-shim-adapter');
    try {
      registerAdapter(adapter);
      expect(getAdapter('test-shim-adapter')).toBe(adapter);
      expect(listAdapters().some((a) => a.sourceId === 'test-shim-adapter')).toBe(true);
    } finally {
      // Restore: remove the test adapter, keep whatever the other tests put there.
      defaultRegistry.clear();
      for (const a of before) defaultRegistry.register(a);
    }
  });
});
