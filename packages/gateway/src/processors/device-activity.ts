import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushDeviceActivityItem } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Store one battery-light device-activity rollup window. Built on-device from a
 * single UsageStatsManager poll inside the existing periodic push. We only state
 * facts (screen-on time, first/last interaction, top apps) — the agent deduces
 * wake/active/idle from get_situation.
 */
export async function processDeviceActivity(
  es: Client,
  userId: string,
  item: PushDeviceActivityItem,
): Promise<void> {
  const doc: Record<string, unknown> = {
    user_id: userId,
    window_start: item.window_start,
    window_end: item.window_end,
    timestamp: item.timestamp, // = window_end, uniform recency sort
  };

  if (item.screen_on_ms !== undefined) doc.screen_on_ms = item.screen_on_ms;
  if (item.unlock_count !== undefined) doc.unlock_count = item.unlock_count;
  if (item.first_interaction != null) doc.first_interaction = item.first_interaction;
  if (item.last_interaction != null) doc.last_interaction = item.last_interaction;
  if (item.interactive_now !== undefined) doc.interactive_now = item.interactive_now;
  if (item.top_apps && item.top_apps.length > 0) {
    doc.top_apps = item.top_apps.map((a) => ({
      package: a.package,
      ...(a.app_name !== undefined ? { app_name: a.app_name } : {}),
      ...(a.category !== undefined ? { category: a.category } : {}),
      ...(a.foreground_ms !== undefined ? { foreground_ms: a.foreground_ms } : {}),
      ...(a.opens !== undefined ? { opens: a.opens } : {}),
    }));
  }

  await es.index({
    index: 'll5_awareness_device_activity',
    id: crypto.randomUUID(),
    document: doc,
    refresh: false,
  });

  logger.debug('[device-activity][processDeviceActivity] Stored', {
    userId,
    window_end: item.window_end,
    screen_on_ms: item.screen_on_ms,
    unlock_count: item.unlock_count,
    top_apps: item.top_apps?.length ?? 0,
  });
}
