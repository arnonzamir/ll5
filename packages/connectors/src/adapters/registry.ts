import type { ConnectorAdapter } from './adapter.js';

/**
 * Registry of ledger adapters, instance-scoped like the health registry so
 * tests construct their own. Phase 0 ships NO adapters: every connector is
 * event-fed (gateway → POST /api/events) or skill-fed (ingest_ledger_rows), and
 * `sync_connector` returns `{ ok: false, reason: 'no_adapter' }`.
 */
export class ConnectorAdapterRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();

  register(adapter: ConnectorAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ConnectorAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ConnectorAdapter[] {
    return Array.from(this.adapters.values());
  }

  clear(): void {
    this.adapters.clear();
  }
}

/** Default process-wide instance for the server. */
export const registry = new ConnectorAdapterRegistry();
