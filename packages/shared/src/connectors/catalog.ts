/**
 * Connector catalog — what the code can do, independent of any user
 * (docs/design/connectors.md, Section 2). One list drives the gateway
 * sourceMap, the Android capture whitelist, the dashboard page and the
 * compose lint. Per-user state (enabled, status, cursor) lives in the
 * connectors MCP's `connectors` table, keyed by `id`.
 *
 * Package ids verified against play.google.com on 2026-09-06 (cal, max, isracard
 * consumer + business, clalit, iec). SMS sender names are best-effort until seen
 * on the phone.
 */
export type ConnectorKind = 'event' | 'ledger' | 'stream';
export type ConnectorAuthType = 'none' | 'scraper_credentials' | 'vault_browser_login' | 'api_token' | 'oauth';
export type ConnectorSensitivity = 'financial' | 'medical' | 'civic' | 'utility' | 'home';
export type ConnectorEventSource = 'phone' | 'webhook' | null;

export interface ConnectorCatalogEntry {
  id: string;
  label: string;
  kinds: ConnectorKind[];
  auth_type: ConnectorAuthType;
  /** Where the EVENT feed comes from; null = ledger-only. */
  event_source: ConnectorEventSource;
  /** Android packages whose notifications the phone forwards for this connector. */
  android_packages?: string[];
  /** SMS sender ids / names whose messages the phone forwards for this connector. */
  sms_senders?: string[];
  /** Ledger pull cadence; null = no scheduled pull (event-only or skill-driven). */
  default_schedule_minutes: number | null;
  sensitivity: ConnectorSensitivity;
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: 'cal',
    label: 'Cal (Visa Cal)',
    kinds: ['event', 'ledger'],
    auth_type: 'scraper_credentials',
    event_source: 'phone',
    android_packages: ['com.onoapps.cal4u'],
    sms_senders: ['Cal', 'כאל'],
    default_schedule_minutes: 720,
    sensitivity: 'financial',
  },
  {
    id: 'max',
    label: 'Max',
    kinds: ['event', 'ledger'],
    auth_type: 'scraper_credentials',
    event_source: 'phone',
    android_packages: ['com.ideomobile.leumicard'],
    sms_senders: ['max', 'MAX', 'מקס'],
    default_schedule_minutes: 720,
    sensitivity: 'financial',
  },
  {
    id: 'isracard',
    label: 'Isracard',
    kinds: ['event', 'ledger'],
    auth_type: 'scraper_credentials',
    event_source: 'phone',
    android_packages: ['com.isracard.hatavot', 'il.co.isracard.MobileDashboard'],
    sms_senders: ['Isracard', 'ישראכרט'],
    default_schedule_minutes: 720,
    sensitivity: 'financial',
  },
  {
    id: 'bank',
    label: 'Bank account',
    kinds: ['event', 'ledger'],
    auth_type: 'scraper_credentials',
    event_source: 'phone',
    android_packages: [],
    sms_senders: [],
    default_schedule_minutes: 1440,
    sensitivity: 'financial',
  },
  {
    id: 'clalit',
    label: 'Clalit (HMO)',
    kinds: ['event', 'ledger'],
    auth_type: 'vault_browser_login',
    event_source: 'phone',
    android_packages: ['clalit.android'],
    sms_senders: ['Clalit', 'כללית'],
    default_schedule_minutes: null,
    sensitivity: 'medical',
  },
  {
    id: 'iec',
    label: 'Israel Electric Corporation',
    kinds: ['event', 'ledger'],
    auth_type: 'api_token',
    event_source: 'phone',
    android_packages: ['com.ewavemobile.electriccompany'],
    sms_senders: ['IEC', 'חברת החשמל'],
    default_schedule_minutes: 60,
    sensitivity: 'utility',
  },
  {
    id: 'municipality',
    label: 'Municipality (city4u)',
    kinds: ['ledger'],
    auth_type: 'vault_browser_login',
    event_source: null,
    default_schedule_minutes: null,
    sensitivity: 'civic',
  },
  {
    id: 'home-assistant',
    label: 'Home Assistant',
    kinds: ['stream', 'ledger'],
    auth_type: 'api_token',
    event_source: 'webhook',
    default_schedule_minutes: 60,
    sensitivity: 'home',
  },
] as const;

export function catalogEntry(id: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}

/** Android package → connector id, for the phone whitelist and the gateway parser dispatch. */
export function connectorForPackage(pkg: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((c) => c.android_packages?.includes(pkg));
}

/** SMS sender → connector id (case-insensitive, trimmed). */
export function connectorForSmsSender(sender: string): ConnectorCatalogEntry | undefined {
  const s = sender.trim().toLowerCase();
  return CONNECTOR_CATALOG.find((c) => c.sms_senders?.some((x) => x.toLowerCase() === s));
}
