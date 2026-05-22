import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushMessageItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import type { NotificationRuleMatcher } from './notification-rules.js';

/** Display label for an app: "SMS", "Slack", "Gmail", … */
function appLabel(app: string): string {
  const a = app.toLowerCase();
  if (a === 'sms') return 'SMS';
  return app.charAt(0).toUpperCase() + app.slice(1);
}

/**
 * Resolve a phone-mirrored message's sender to a known person + display name,
 * and enrich the messaging_contacts row so repeat senders are tracked (the same
 * cross-platform table WhatsApp uses — keyed `platform=app`, e.g. 'sms'/'slack'/
 * 'gmail'). Never overwrites a curated display_name or an existing person link.
 */
async function resolveAndEnrichSender(
  pgPool: Pool,
  userId: string,
  platform: string,
  platformId: string,
  fallbackName: string,
  isGroup: boolean,
): Promise<{ personId: string | null; displayName: string }> {
  try {
    const r = await pgPool.query<{ person_id: string | null; display_name: string | null }>(
      `INSERT INTO messaging_contacts
         (user_id, platform, platform_id, display_name, is_group, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, platform, platform_id)
       DO UPDATE SET last_seen_at = NOW(), updated_at = NOW(),
         display_name = COALESCE(NULLIF(messaging_contacts.display_name, ''), EXCLUDED.display_name)
       RETURNING person_id, display_name`,
      [userId, platform, platformId, fallbackName, isGroup],
    );
    return {
      personId: r.rows[0]?.person_id ?? null,
      displayName: r.rows[0]?.display_name || fallbackName,
    };
  } catch (err) {
    logger.warn('[message][resolveAndEnrichSender] contact resolve failed (non-critical)', {
      error: err instanceof Error ? err.message : String(err),
      platform,
    });
    return { personId: null, displayName: fallbackName };
  }
}

/**
 * Process a phone-mirrored message push (SMS / Slack / email / etc.):
 * 1. Resolve+enrich the sender (person_id + display name) like WhatsApp does
 * 2. Write to ll5_awareness_messages (with conversation_id + person_id)
 * 3. Write/update entity status
 * 4. Notification-rule match (with platform/conversation_id/person_id) and, on
 *    immediate/agent priority, surface a system message WITH source routing so
 *    the agent knows exactly who sent it and can recall/get_narrative on them.
 */
export async function processMessage(
  es: Client,
  userId: string,
  item: PushMessageItem,
  pgPool?: Pool,
  matcher?: NotificationRuleMatcher,
): Promise<void> {
  const isGroup = !!item.is_group;
  // Synthesised conversation key (phone notifications have no native thread id):
  // groups → app:group:<name>, 1:1 → app:<sender>. The agent's stable handle.
  const convKey = isGroup && item.group_name
    ? `${item.app}:group:${item.group_name}`
    : `${item.app}:${item.sender}`;

  // Resolve the sender to a known person + display name (and track them).
  let personId: string | null = null;
  let contactDisplayName = item.sender;
  if (pgPool) {
    const resolved = await resolveAndEnrichSender(pgPool, userId, item.app, item.sender, item.sender, isGroup);
    personId = resolved.personId;
    contactDisplayName = resolved.displayName;
  }
  // The peer the agent reasons about: the group for group messages, else the sender.
  const peerName = isGroup ? (item.group_name || convKey) : contactDisplayName;

  // Write message document (now carries conversation_id + person_id for later query).
  const messageDoc: Record<string, unknown> = {
    user_id: userId,
    sender: item.sender,
    app: item.app,
    content: item.body,
    processed: false,
    timestamp: item.timestamp,
    conversation_id: convKey,
  };
  if (item.is_group !== undefined) messageDoc.is_group = item.is_group;
  if (item.group_name) messageDoc.group_name = item.group_name;
  if (!isGroup && personId) messageDoc.person_id = personId;

  const docId = crypto.randomUUID();
  await es.index({ index: 'll5_awareness_messages', id: docId, document: messageDoc, refresh: false });

  logger.info('[message][processMessage] IM message received', {
    sender: item.sender,
    app: item.app,
    is_group: isGroup,
    group_name: item.group_name ?? null,
    person_id: personId ?? null,
    bodyLength: item.body.length,
  });

  await updateEntityStatus(es, userId, item);

  if (pgPool && matcher) {
    const priority = await matcher.match(userId, {
      sender: item.sender,
      app: item.app,
      body: item.body,
      is_group: item.is_group,
      group_name: item.group_name,
      platform: item.app,
      conversation_id: convKey,
      person_id: personId ?? undefined,
    });

    logger.info('[message][processMessage] Notification rule match', {
      sender: item.sender,
      app: item.app,
      priority: priority ?? 'no-match',
    });

    if (priority === 'ignore') {
      await es.update({ index: 'll5_awareness_messages', id: docId, doc: { processed: true }, refresh: false });
      logger.debug('[message][processMessage] Ignored message marked processed', { sender: item.sender, app: item.app });
      return;
    }

    if (priority === 'immediate' || priority === 'agent') {
      const truncBody = item.body.length > 2000 ? item.body.slice(0, 2000) + '...' : item.body;
      // Name the sender + thread: "[Slack] Alice in eng-sync: …" / "[SMS] Mom: …"
      const groupInfo = isGroup && item.group_name ? ` in ${item.group_name}` : '';
      await insertSystemMessage(
        pgPool,
        userId,
        `[${appLabel(item.app)}] ${peerName}${groupInfo}: "${truncBody}"`,
        undefined, // notify
        undefined, // schedulerEvent
        {
          platform: item.app,
          remote_jid: convKey,
          sender_name: item.sender,
          contact_name: peerName || undefined,
          person_id: (!isGroup ? personId : null) ?? undefined,
          from_me: false,
          is_group: isGroup,
          group_name: item.group_name ?? undefined,
        },
      );

      await es.update({ index: 'll5_awareness_messages', id: docId, doc: { processed: true }, refresh: false });
      logger.info('[message][processMessage] Immediate notification sent', { sender: item.sender, app: item.app, person_id: personId ?? null });
    }
  } else {
    logger.warn('[message][processMessage] Notification rule matcher not available', { hasPgPool: !!pgPool, hasMatcher: !!matcher });
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

    logger.debug('[message][updateEntityStatus] Entity status updated', {
      entity_name: item.sender,
      source: item.app,
    });
  } catch (err) {
    // Entity status update is non-critical — log and continue
    logger.warn('[message][updateEntityStatus] Failed to update entity status', {
      error: err instanceof Error ? err.message : String(err),
      sender: item.sender,
    });
  }
}
