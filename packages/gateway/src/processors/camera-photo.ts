import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import type { PushCameraPhotoItem } from '../types/index.js';

const MEDIA_INDEX = 'll5_media';

/**
 * A camera photo the user just took on the phone. We index it into the shared
 * ll5_media store (source:'camera', with the capture time + GPS so the agent can
 * MATCH it to calendar events / locations / journal), then surface a concise
 * system message so the agent can react proactively-but-selectively (inspect
 * reminder-worthy shots — whiteboards, documents, parking spots, products — and
 * stay quiet on the rest; see the persona). No phone notification: the user is
 * holding the phone.
 */
export async function processCameraPhoto(
  es: Client,
  pool: Pool | undefined,
  userId: string,
  item: PushCameraPhotoItem,
): Promise<void> {
  const tags: string[] = ['camera'];
  if (item.bucket) tags.push(item.bucket);

  const doc: Record<string, unknown> = {
    user_id: userId,
    url: item.url,
    mime_type: item.mime_type ?? 'image/jpeg',
    filename: item.filename ?? null,
    description: null,
    source: 'camera',
    tags,
    created_at: item.timestamp,
    // Extra fields for event-matching (dynamic-mapped; not in the base schema):
    taken_at: item.timestamp,
    lat: item.lat ?? null,
    lon: item.lon ?? null,
    width: item.width ?? null,
    height: item.height ?? null,
  };

  let mediaId: string | null = null;
  try {
    const res = await es.index({ index: MEDIA_INDEX, document: doc, refresh: false });
    mediaId = res._id;
  } catch (err) {
    logger.error('[camera-photo][process] Failed to index media', { error: String(err), userId });
    return;
  }

  logger.info('[camera-photo][process] Indexed camera photo', { userId, mediaId, hasGps: item.lat != null });

  // Surface to the agent. Screenshots/non-camera buckets are captured but not
  // announced (rarely reminder-worthy, and they'd be noisy).
  if (pool && (item.bucket ?? 'Camera').toLowerCase().includes('camera')) {
    const when = new Date(item.timestamp).toLocaleString('en-US', {
      timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric',
    });
    const loc = item.lat != null && item.lon != null ? ` near ${item.lat.toFixed(4)},${item.lon.toFixed(4)}` : '';
    const content = `[Photo] You took a photo at ${when}${loc}. media_id=${mediaId} url=${item.url} — inspect it only if it looks reminder-worthy (whiteboard, document, parking spot, product, place); otherwise note it silently and link it to the matching event/person if obvious.`;
    try {
      await insertSystemMessage(pool, userId, content);
    } catch (err) {
      logger.warn('[camera-photo][process] Failed to surface photo system message', { error: String(err), userId });
    }
  }
}
