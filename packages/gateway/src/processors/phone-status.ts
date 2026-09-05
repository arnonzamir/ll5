import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushPhoneStatusItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { maybeAlertLowBattery } from './battery-alert.js';

export async function processPhoneStatus(
  es: Client,
  pool: Pool | undefined,
  userId: string,
  item: PushPhoneStatusItem,
): Promise<void> {
  const doc: Record<string, unknown> = {
    user_id: userId,
    battery_pct: item.battery_pct,
    is_charging: item.is_charging,
    timestamp: item.timestamp,
  };

  if (item.plug_type !== undefined) doc.plug_type = item.plug_type;
  if (item.battery_temp_c !== undefined) doc.battery_temp_c = item.battery_temp_c;
  if (item.battery_health !== undefined) doc.battery_health = item.battery_health;
  if (item.low_power_mode !== undefined) doc.low_power_mode = item.low_power_mode;
  if (item.storage_used_bytes !== undefined) doc.storage_used_bytes = item.storage_used_bytes;
  if (item.storage_total_bytes !== undefined) doc.storage_total_bytes = item.storage_total_bytes;
  if (item.ram_used_bytes !== undefined) doc.ram_used_bytes = item.ram_used_bytes;
  if (item.ram_total_bytes !== undefined) doc.ram_total_bytes = item.ram_total_bytes;
  if (item.trigger !== undefined) doc.trigger = item.trigger;
  // Notification-listener liveness — the ground truth channel.mirror reads back
  // (android review 2026-09-05, improvement 1). Absent on older app builds.
  if (item.notification_listener_enabled !== undefined) {
    doc.notification_listener_enabled = item.notification_listener_enabled;
  }
  if (item.notification_listener_connected !== undefined) {
    doc.notification_listener_connected = item.notification_listener_connected;
  }

  await es.index({
    index: 'll5_awareness_phone_statuses',
    id: crypto.randomUUID(),
    document: doc,
    refresh: false,
  });

  logger.debug('[phone-status][processPhoneStatus] Stored', {
    userId,
    battery_pct: item.battery_pct,
    is_charging: item.is_charging,
    trigger: item.trigger,
  });

  // Proactive escalating low-battery alert (discharging only). In-memory
  // per-user episode state; each threshold (20/10/5) fires at most once per
  // discharge episode and resets on charge / recovery above 20%.
  if (pool && item.battery_pct !== undefined && item.is_charging !== undefined) {
    await maybeAlertLowBattery(pool, userId, item.battery_pct, item.is_charging);
  }
}
