import type { HealthSourceAdapter } from './adapter.js';

/**
 * Registry of available health source adapters.
 *
 * Instances hold their adapter map as an instance field — no process-global
 * state. This lets tests `new HealthClientRegistry()` per case and stay
 * isolated even under `--pool=threads`.
 *
 * Production callers should keep using the `registry` default-instance export
 * (and the `registerAdapter` / `getAdapter` / `listAdapters` shims around it),
 * so existing call sites don't change.
 */
export class HealthClientRegistry {
  private readonly adapters = new Map<string, HealthSourceAdapter>();

  register(adapter: HealthSourceAdapter): void {
    this.adapters.set(adapter.sourceId, adapter);
  }

  get(sourceId: string): HealthSourceAdapter | undefined {
    return this.adapters.get(sourceId);
  }

  list(): HealthSourceAdapter[] {
    return Array.from(this.adapters.values());
  }

  clear(): void {
    this.adapters.clear();
  }
}

/**
 * Default process-wide instance for production callers. Tests should construct
 * their own `HealthClientRegistry` rather than mutate this one.
 */
export const registry = new HealthClientRegistry();

// Back-compat shims — keep the previous function-style API working so we
// don't have to touch every call site in this PR.
export function registerAdapter(adapter: HealthSourceAdapter): void {
  registry.register(adapter);
}

export function getAdapter(sourceId: string): HealthSourceAdapter | undefined {
  return registry.get(sourceId);
}

export function listAdapters(): HealthSourceAdapter[] {
  return registry.list();
}
