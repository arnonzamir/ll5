import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushDeviceActivityItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { timeBanner } from '@ll5/shared';

/**
 * Store one battery-light device-activity rollup window. Built on-device from a
 * single UsageStatsManager poll (or pushed immediately by the screen/unlock
 * receiver). We only state facts (screen-on time, first/last interaction, top
 * apps) — the agent deduces wake/active/idle from get_situation. When the window
 * is a middle-of-the-night unlock after an idle gap, we ALSO wake the agent (see
 * maybeWakeOnNightActivity) since it would otherwise stay quiet overnight.
 */
export async function processDeviceActivity(
  es: Client,
  userId: string,
  item: PushDeviceActivityItem,
  pgPool?: Pool,
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

  if (pgPool) {
    try {
      await maybeWakeOnNightActivity(es, pgPool, userId, item);
    } catch (err) {
      logger.warn('[device-activity][nightWake] check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const NIGHT_START_HOUR = 0;   // local hour (inclusive) — deep-night window
const NIGHT_END_HOUR = 6;     // local hour (exclusive)
const IDLE_GAP_MIN = 45;      // a "wake" = activity after >= this many quiet minutes
const DEDUP_MIN = 30;         // don't re-fire within this many minutes

/**
 * If this window is a middle-of-the-night phone-touch after an idle gap, insert a
 * system message so the agent KNOWS now — overnight the heartbeat/transition
 * cues are gated off, so without this the agent would only learn at morning. A
 * 3am unlock can be significant (can't sleep, anxious, something happened).
 */
async function maybeWakeOnNightActivity(
  es: Client,
  pgPool: Pool,
  userId: string,
  item: PushDeviceActivityItem,
): Promise<void> {
  // Only a genuine interaction counts (an unlock, or a screen-on interaction).
  const interacted = (item.unlock_count ?? 0) > 0 || item.first_interaction != null;
  if (!interacted) return;

  const tz = await getUserTimezone(pgPool, userId);
  const atIso = item.first_interaction ?? item.window_end;
  const at = new Date(atIso);
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(at),
    10,
  );
  if (hour < NIGHT_START_HOUR || hour >= NIGHT_END_HOUR) return;

  // Idle gap: was there device activity shortly before this? If the previous
  // window is recent, this is continued late-night use, not a fresh wake.
  const prev = await es.search({
    index: 'll5_awareness_device_activity',
    query: {
      bool: {
        filter: [
          { term: { user_id: userId } },
          { range: { timestamp: { lt: atIso } } },
        ],
      },
    },
    size: 1,
    sort: [{ timestamp: { order: 'desc' } }],
    _source: ['timestamp'],
  });
  const prevTs = (prev.hits.hits[0]?._source as Record<string, unknown> | undefined)?.timestamp as string | undefined;
  if (prevTs) {
    const gapMin = (at.getTime() - new Date(prevTs).getTime()) / 60000;
    if (gapMin < IDLE_GAP_MIN) return; // continuous use, not a wake
  }

  // Dedup: don't fire again within the episode.
  const dup = await pgPool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM chat_messages
     WHERE user_id = $1 AND channel = 'system' AND direction = 'inbound'
       AND content LIKE '[Night Activity]%' AND created_at > NOW() - INTERVAL '${DEDUP_MIN} minutes'`,
    [userId],
  );
  if (parseInt(dup.rows[0]?.c ?? '0', 10) > 0) return;

  const banner = timeBanner(at, tz);
  const topApp = item.top_apps?.[0]?.app_name ?? item.top_apps?.[0]?.package;
  const lines = [
    `[Night Activity] ${banner}`,
    `The user just used their phone in the middle of the night (unlock${topApp ? `, opened ${topApp}` : ''}) after being quiet. This can be significant — trouble sleeping, anxious, or something happened.`,
    'Run situation-check. Read it gently: most night wakes are nothing. Only push if there is a real reason (an unanswered urgent thread, a clear distress signal); otherwise note_observation and let them be.',
  ];

  const evt = createSchedulerEvent('night_activity');
  await insertSystemMessage(pgPool, userId, lines.join('\n'), undefined, evt);
  logger.info('[device-activity][nightWake] Night-activity cue sent', { userId, hour });
}

async function getUserTimezone(pgPool: Pool, userId: string): Promise<string> {
  try {
    const r = await pgPool.query<{ tz: string | null }>(
      "SELECT settings->>'timezone' AS tz FROM user_settings WHERE user_id = $1",
      [userId],
    );
    return r.rows[0]?.tz || 'Asia/Jerusalem';
  } catch {
    return 'Asia/Jerusalem';
  }
}
