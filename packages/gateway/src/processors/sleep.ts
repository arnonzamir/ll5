import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushSleepSegmentItem, PushSleepClassifyItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { writeNotableEvent } from './notable.js';

const SLEEP_INDEX = 'll5_awareness_sleep';

/** Format minutes as "Xh Ym" (or "Ym" under an hour). */
function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Local HH:MM (24h) for a timestamp. Best-effort; falls back to UTC slice. */
function localHm(iso: string, timezone = 'Asia/Jerusalem'): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    });
  } catch {
    return iso.slice(11, 16);
  }
}

/**
 * Store a completed sleep SEGMENT from the on-device Sleep API. status SUCCESS is a
 * real interval; MISSING_DATA / NOT_DETECTED carry no usable window but are stored
 * for completeness. On a SUCCESS segment we ALSO write a "sleep summary" notable
 * event so the agent can surface it on the morning wake. Throttling already
 * happened on-device.
 */
export async function processSleepSegment(
  es: Client,
  userId: string,
  item: PushSleepSegmentItem,
): Promise<void> {
  await es.index({
    index: SLEEP_INDEX,
    id: crypto.randomUUID(),
    document: {
      user_id: userId,
      kind: 'segment',
      start: item.start,
      end: item.end,
      duration_min: item.duration_min,
      status: item.status,
      timestamp: item.timestamp,
    },
    refresh: false,
  });

  logger.debug('[sleep][processSleepSegment] Stored', {
    userId,
    status: item.status,
    duration_min: item.duration_min,
  });

  if (item.status === 'SUCCESS') {
    const summary = `Slept ~${fmtDuration(item.duration_min)} (${localHm(item.start)}–${localHm(item.end)})`;
    await writeNotableEvent(es, userId, {
      event_type: 'sleep_summary',
      timestamp: item.timestamp,
      summary,
      severity: 'low',
      payload: {
        start: item.start,
        end: item.end,
        duration_min: item.duration_min,
      },
    });
  }
}

/**
 * Store an instantaneous sleep CLASSIFY reading (light + motion + confidence) from
 * the Sleep API. Pure storage — no agent wake. NOTE: the contract key is
 * `motion_level` (not `motion`); we persist it under the same name.
 */
export async function processSleepClassify(
  es: Client,
  userId: string,
  item: PushSleepClassifyItem,
): Promise<void> {
  await es.index({
    index: SLEEP_INDEX,
    id: crypto.randomUUID(),
    document: {
      user_id: userId,
      kind: 'classify',
      confidence: item.confidence,
      light: item.light,
      motion_level: item.motion_level,
      timestamp: item.timestamp,
    },
    refresh: false,
  });

  logger.debug('[sleep][processSleepClassify] Stored', {
    userId,
    confidence: item.confidence,
    light: item.light,
    motion_level: item.motion_level,
  });
}
