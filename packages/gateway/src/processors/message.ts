import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushMessageItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import type { NotificationRuleMatcher } from './notification-rules.js';

/**
 * Process a message push item:
 * 1. Write to ll5_awareness_messages
 * 2. Write/update entity status in ll5_awareness_entity_statuses
 */
export async function processMessage(
  es: Client,
  userId: string,
  item: PushMessageItem,
  pgPool?: Pool,
  matcher?: NotificationRuleMatcher,
): Promise<void> {
  // Write message document
  const messageDoc: Record<string, unknown> = {
    user_id: userId,
    sender: item.sender,
    app: item.app,
    content: item.body,
    processed: false,
    timestamp: item.timestamp,
  };

  if (item.is_group !== undefined) {
    messageDoc.is_group = item.is_group;
  }

  if (item.group_name) {
    messageDoc.group_name = item.group_name;
  }

  await es.index({
    index: 'll5_awareness_messages',
    id: crypto.randomUUID(),
    document: messageDoc,
    refresh: false,
  });

  logger.info('IM message received', {
    sender: item.sender,
    app: item.app,
    is_group: item.is_group ?? false,
    group_name: item.group_name ?? null,
    bodyLength: item.body.length,
  });

  // Update entity status — use sender as entity_name
  await updateEntityStatus(es, userId, item);

  // Check notification rules for immediate priority messages
  if (pgPool && matcher) {
    const priority = await matcher.match(userId, {
      sender: item.sender,
      app: item.app,
      body: item.body,
      is_group: item.is_group,
      group_name: item.group_name,
    });

    logger.info('Notification rule match', {
      sender: item.sender,
      app: item.app,
      priority: priority ?? 'no-match',
    });

    if (priority === 'immediate') {
      const truncBody = item.body.length > 200 ? item.body.slice(0, 200) + '...' : item.body;
      const groupInfo = item.is_group && item.group_name ? ` (group: ${item.group_name})` : '';
      await insertSystemMessage(
        pgPool,
        userId,
        `[IM Notification] ${item.sender} on ${item.app}${groupInfo}: "${truncBody}"`,
      );
      logger.info('Immediate notification sent', { sender: item.sender, app: item.app });
    }
  } else {
    logger.warn('Notification rule matcher not available', { hasPgPool: !!pgPool, hasMatcher: !!matcher });
  }
}

/**
 * Write or update an entity status document.
 * Uses update-by-query to find existing status for this entity, or creates a new one.
 * We use a deterministic ID based on user_id + entity_name to enable upserts.
 */
async function updateEntityStatus(
  es: Client,
  userId: string,
  item: PushMessageItem,
): Promise<void> {
  try {
    // Deterministic ID: same entity always overwrites its status
    const entityId = crypto
      .createHash('sha256')
      .update(`${userId}:${item.sender.toLowerCase()}`)
      .digest('hex')
      .slice(0, 20);

    const statusDoc: Record<string, unknown> = {
      user_id: userId,
      entity_name: item.sender,
      summary: item.body,
      source: item.app,
      timestamp: item.timestamp,
    };

    await es.index({
      index: 'll5_awareness_entity_statuses',
      id: entityId,
      document: statusDoc,
      refresh: false,
    });

    logger.debug('Entity status updated', {
      entity_name: item.sender,
      source: item.app,
    });
  } catch (err) {
    // Entity status update is non-critical — log and continue
    logger.warn('Failed to update entity status', {
      error: err instanceof Error ? err.message : String(err),
      sender: item.sender,
    });
  }
}
