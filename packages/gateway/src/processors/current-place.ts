import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushCurrentPlaceItem } from '../types/index.js';
import { logger } from '../utils/logger.js';

const CURRENT_PLACE_INDEX = 'll5_awareness_current_place';

/**
 * Store one on-device "current place" candidate set (likelihood-ranked Places
 * results). Pure enrichment — no agent wake; the agent can read the top candidate
 * for "what kind of place am I at" context. One doc per push.
 */
export async function processCurrentPlace(
  es: Client,
  userId: string,
  item: PushCurrentPlaceItem,
): Promise<void> {
  await es.index({
    index: CURRENT_PLACE_INDEX,
    id: crypto.randomUUID(),
    document: {
      user_id: userId,
      candidates: item.candidates,
      timestamp: item.timestamp,
    },
    refresh: false,
  });

  logger.debug('[current-place][processCurrentPlace] Stored', {
    userId,
    candidates: item.candidates.length,
    top: item.candidates[0]?.name,
  });
}
