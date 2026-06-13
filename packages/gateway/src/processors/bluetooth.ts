import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushBluetoothItem } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Store a Bluetooth connect/disconnect event. device_class lets the agent infer
 * context (car → driving, headset → commute/workout, wearable → on-body) without
 * us asserting the activity.
 */
export async function processBluetooth(
  es: Client,
  userId: string,
  item: PushBluetoothItem,
): Promise<void> {
  const doc: Record<string, unknown> = {
    user_id: userId,
    connected: item.connected,
    timestamp: item.timestamp,
  };

  if (item.device_name != null) doc.device_name = item.device_name;
  if (item.device_address != null) doc.device_address = item.device_address;
  if (item.device_class !== undefined) doc.device_class = item.device_class;

  await es.index({
    index: 'll5_awareness_bluetooth',
    id: crypto.randomUUID(),
    document: doc,
    refresh: false,
  });

  logger.debug('[bluetooth][processBluetooth] Stored', {
    userId,
    connected: item.connected,
    device_class: item.device_class,
  });
}
