import type { HealthSourceAdapter } from './adapter.js';

// Registry of available health source adapters
const adapters = new Map<string, HealthSourceAdapter>();

export function registerAdapter(adapter: HealthSourceAdapter): void {
  adapters.set(adapter.sourceId, adapter);
}

export function getAdapter(sourceId: string): HealthSourceAdapter | undefined {
  return adapters.get(sourceId);
}

export function listAdapters(): HealthSourceAdapter[] {
  return Array.from(adapters.values());
}
