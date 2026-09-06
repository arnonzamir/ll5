import { describe, it, expect } from 'vitest';
import { CONNECTOR_CATALOG, catalogEntry, connectorForPackage, connectorForSmsSender } from '../connectors/index.js';

describe('connector catalog', () => {
  it('has unique ids and consistent event sources', () => {
    const ids = CONNECTOR_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CONNECTOR_CATALOG) {
      if (c.event_source === 'phone') expect(c.android_packages !== undefined || c.sms_senders !== undefined).toBe(true);
      if (c.event_source === null) expect(c.kinds).not.toContain('event');
    }
  });
  it('resolves packages and SMS senders', () => {
    expect(connectorForPackage('com.onoapps.cal4u')?.id).toBe('cal');
    expect(connectorForSmsSender(' isracard ')?.id).toBe('isracard');
    expect(connectorForSmsSender('unknown-sender')).toBeUndefined();
    expect(catalogEntry('home-assistant')?.auth_type).toBe('api_token');
  });
  it('financy is a scheduled, ledger-only, oauth-credentialed financial connector', () => {
    const f = catalogEntry('financy');
    expect(f).toMatchObject({ kinds: ['ledger'], auth_type: 'oauth', event_source: null, default_schedule_minutes: 360, sensitivity: 'financial' });
    expect(f?.android_packages).toBeUndefined();
  });
});
