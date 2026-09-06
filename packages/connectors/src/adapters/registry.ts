import type { ConnectorAdapter } from './adapter.js';
import { FinancyAdapter } from './financy.js';

/**
 * Registry of ledger adapters, instance-scoped like the health registry so
 * tests construct their own. Built-in adapters: `financy` (Open-Finance.ai,
 * read-only). Every other connector is event-fed (gateway → POST /api/events)
 * or skill-fed (ingest_ledger_rows) and `sync_connector` returns
 * `{ ok: false, reason: 'no_adapter' }` for it.
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

/** Register the adapters that ship with the service. */
export function registerBuiltinAdapters(target: ConnectorAdapterRegistry): void {
  target.register(new FinancyAdapter());
}

/** Default process-wide instance for the server, with the built-in adapters. */
export const registry = new ConnectorAdapterRegistry();
registerBuiltinAdapters(registry);
