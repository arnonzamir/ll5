/**
 * Phone notification capture — the gateway side of the phone's ONE generic
 * notification listener (2026-09-08: per-connector capture on the phone is
 * retired; the gateway routes by package, see processors/app-notification.ts).
 *
 * Two pure helpers:
 *   - connectorCaptureCommands(patch): when a `data_sources.connector_<id>`
 *     toggle is written (PUT /user-settings from /settings/connectors), the
 *     phone must add / drop that connector's packages in its capture
 *     include-list (only matters in include-list mode). Emitted as the
 *     existing `update_data_source` device command with the connector's
 *     catalog packages: `{ source: 'connector_<id>', enabled, packages: [...] }`.
 *   - notificationCaptureSeed(sources): GET /me/notification-capture — what the
 *     app seeds its include-list with on start: packages of every enabled
 *     connector plus the IM packages (whose notifications the gateway drops,
 *     the message path carries them; the app still must capture them).
 *
 * "Enabled" follows the gateway gate (isSourceEnabled): a connector that was
 * never toggled counts as enabled, because that is what the gateway does with
 * its notifications.
 */
import { CONNECTOR_CATALOG, catalogEntry } from '@ll5/shared';
import { IM_PACKAGES } from '../processors/app-notification.js';

export const CONNECTOR_SOURCE_PREFIX = 'connector_';
export const UPDATE_DATA_SOURCE_COMMAND = 'update_data_source';

export interface ConnectorCaptureCommand {
  source: string;
  enabled: boolean;
  packages: string[];
}

export interface NotificationCaptureSeed {
  connector_packages: Record<string, string[]>;
  im_packages: string[];
}

type DataSources = Record<string, { enabled?: boolean } | undefined> | null | undefined;

/** Pure: connector id for a `connector_<id>` data-source key, else null. */
export function connectorIdFromSourceKey(key: string): string | null {
  return key.startsWith(CONNECTOR_SOURCE_PREFIX) ? key.slice(CONNECTOR_SOURCE_PREFIX.length) : null;
}

/**
 * Pure: the device commands a `data_sources` patch implies. Only `connector_*`
 * keys naming a catalog connector with Android packages produce one — the
 * other data-source toggles are already synced by the dashboard's
 * data-sources page, and a connector without packages (SMS-only) has nothing
 * for the phone to include.
 */
export function connectorCaptureCommands(patch: DataSources): ConnectorCaptureCommand[] {
  if (!patch || typeof patch !== 'object') return [];
  const out: ConnectorCaptureCommand[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const id = connectorIdFromSourceKey(key);
    if (!id || !value || typeof value !== 'object' || typeof value.enabled !== 'boolean') continue;
    const entry = catalogEntry(id);
    const packages = entry?.android_packages ?? [];
    if (packages.length === 0) continue;
    out.push({ source: key, enabled: value.enabled, packages: [...packages] });
  }
  return out;
}

/** Pure: the include-list seed for the app, from `user_settings.settings.data_sources`. */
export function notificationCaptureSeed(sources: DataSources): NotificationCaptureSeed {
  const ds = sources && typeof sources === 'object' ? sources : {};
  const connector_packages: Record<string, string[]> = {};
  for (const entry of CONNECTOR_CATALOG) {
    const packages = entry.android_packages ?? [];
    if (packages.length === 0) continue;
    const enabled = ds[`${CONNECTOR_SOURCE_PREFIX}${entry.id}`]?.enabled ?? true;
    if (!enabled) continue;
    connector_packages[entry.id] = [...packages];
  }
  return { connector_packages, im_packages: [...IM_PACKAGES] };
}
