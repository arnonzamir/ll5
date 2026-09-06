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
/** No scrapers and no portal automation (Arnon, 2026-09-06): only phone events, official APIs and a licensed aggregator. */
export type ConnectorAuthType = 'none' | 'api_token' | 'oauth';
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
    kinds: ['event'],
    auth_type: 'none',
    event_source: 'phone',
    android_packages: ['com.onoapps.cal4u'],
    sms_senders: ['Cal', 'כאל'],
    default_schedule_minutes: null,
    sensitivity: 'financial',
  },
  {
    id: 'max',
    label: 'Max',
    kinds: ['event'],
    auth_type: 'none',
    event_source: 'phone',
    android_packages: ['com.ideomobile.leumicard'],
    sms_senders: ['max', 'MAX', 'מקס'],
    default_schedule_minutes: null,
    sensitivity: 'financial',
  },
  {
    id: 'isracard',
    label: 'Isracard',
    kinds: ['event'],
    auth_type: 'none',
    event_source: 'phone',
    android_packages: ['com.isracard.hatavot', 'il.co.isracard.MobileDashboard'],
    sms_senders: ['Isracard', 'ישראכרט'],
    default_schedule_minutes: null,
    sensitivity: 'financial',
  },
  {
    id: 'bank',
    label: 'Bank notifications (Discount, Leumi, OneZero)',
    kinds: ['event'],
    auth_type: 'none',
    event_source: 'phone',
    android_packages: ['com.ideomobile.discount', 'com.leumi.leumiwallet'],
    sms_senders: ['Discount', 'דיסקונט', 'Leumi', 'לאומי', 'ONEZEROBANK'],
    default_schedule_minutes: null,
    sensitivity: 'financial',
  },
  {
    id: 'paybox',
    label: 'PayBox',
    kinds: ['event'],
    auth_type: 'none',
    event_source: 'phone',
    android_packages: ['com.payboxapp'],
    sms_senders: ['PayBox'],
    default_schedule_minutes: null,
    sensitivity: 'financial',
  },
  {
    id: 'clalit',
    label: 'Clalit (HMO)',
    kinds: ['event'],
    auth_type: 'none',
    event_source: 'phone',
    android_packages: ['clalit.android'],
    sms_senders: ['Clalit', 'כללית'],
    default_schedule_minutes: null,
    sensitivity: 'medical',
  },
  {
    id: 'iec',
    label: 'Israel Electric Corporation',
    kinds: ['event'],
    auth_type: 'none',
    event_source: 'phone',
    android_packages: ['com.ewavemobile.electriccompany'],
    sms_senders: ['IEC', 'חברת החשמל'],
    default_schedule_minutes: null,
    sensitivity: 'utility',
  },
  {
    id: 'water',
    label: 'Water corporation (Mayanot HaCarmel)',
    kinds: ['event'],
    auth_type: 'none',
    event_source: 'phone',
    android_packages: [],
    sms_senders: ['MayanotH'],
    default_schedule_minutes: null,
    sensitivity: 'utility',
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
  {
    // Open-Finance.ai (licensed Israeli open-banking aggregator). Ledger only:
    // the adapter reads what Financy already fetched (read-only data endpoints,
    // never /connections/refresh or any payment endpoint). Card EVENTS still
    // arrive under cal / max / isracard / bank; the reconciler matches them
    // user-wide against these rows.
    id: 'financy',
    label: 'Financy (licensed open-banking aggregator: the ledger for every bank and card)',
    kinds: ['ledger'],
    auth_type: 'oauth',
    event_source: null,
    default_schedule_minutes: 360,
    sensitivity: 'financial',
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
