import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushMessageItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import { buildSourceRouting, enrichContact, parseMessageAuthor } from './message-identity.js';
import type { NotificationRuleMatcher } from './notification-rules.js';

/** Display label for an app: "SMS", "Slack", "Gmail", "WhatsApp", … */
function appLabel(app: string): string {
  const a = app.toLowerCase();
  if (a === 'sms') return 'SMS';
  if (a === 'whatsapp') return 'WhatsApp';
  return app.charAt(0).toUpperCase() + app.slice(1);
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

  // Parse the REAL author out of the notification title (strips Slack's
  // "#channel: " prefix and detects bot integrations) — see message-identity.ts.
  const author = parseMessageAuthor(item.app, item.sender, item.group_name, isGroup);

  // Synthesised conversation key (phone notifications have no native thread id):
  // groups (Slack channels / email accounts) → app:group:<name>, 1:1 → app:<author>.
  const convKey = isGroup && item.group_name
    ? `${item.app}:group:${item.group_name}`
    : `${item.app}:${author.authorId}`;

  // Resolve+enrich the AUTHOR (not the channel) to a known person + display name.
  // Done even for "group" channels — a Slack author is a real person/bot worth
  // tracking and linking, unlike a WhatsApp group whose peer is the group itself.
  let personId: string | null = null;
  let speakerName = author.authorName;
  if (pgPool) {
    const resolved = await enrichContact(pgPool, userId, item.app, author.authorId, author.authorName, {
      phoneNumber: author.phoneNumber,
      isGroup,
    });
    personId = resolved.personId;
    speakerName = resolved.displayName;
  }

  // Write message document — carries the clean author, conversation_id, person_id
  // and a `source` so phone-pushed messages are queryable like WhatsApp's.
  const messageDoc: Record<string, unknown> = {
    user_id: userId,
    sender: item.sender,        // raw notification title (kept for continuity)
    author: speakerName,        // resolved author display name
    app: item.app,
    content: item.body,
    processed: false,
    timestamp: item.timestamp,
    conversation_id: convKey,
    source: 'phone',
  };
  if (item.is_group !== undefined) messageDoc.is_group = item.is_group;
  if (item.group_name) messageDoc.group_name = item.group_name;
  if (author.isBot) messageDoc.is_bot = true;
  if (personId) messageDoc.person_id = personId;

  const docId = crypto.randomUUID();
  await es.index({ index: 'll5_awareness_messages', id: docId, document: messageDoc, refresh: false });

  logger.info('[message][processMessage] IM message received', {
    app: item.app,
    author: speakerName,
    is_group: isGroup,
    is_bot: author.isBot,
    group_name: item.group_name ?? null,
    person_id: personId ?? null,
    bodyLength: item.body.length,
  });

  await updateEntityStatus(es, userId, item, speakerName);

  if (pgPool && matcher) {
    const priority = await matcher.match(userId, {
      sender: speakerName,        // clean author so sender-rules match the person/bot
      app: item.app,
      body: item.body,
      is_group: item.is_group,
      group_name: item.group_name,
      platform: item.app,
      conversation_id: convKey,
      person_id: personId ?? undefined,
    });

    logger.info('[message][processMessage] Notification rule match', {
      app: item.app,
      author: speakerName,
      priority: priority ?? 'no-match',
    });

    if (priority === 'ignore') {
      await es.update({ index: 'll5_awareness_messages', id: docId, doc: { processed: true }, refresh: false });
      logger.debug('[message][processMessage] Ignored message marked processed', { author: speakerName, app: item.app });
      return;
    }

    if (priority === 'immediate' || priority === 'agent') {
      const truncBody = item.body.length > 2000 ? item.body.slice(0, 2000) + '...' : item.body;
      // Name the author + channel: "[Slack] Opsgenie in #data-platform-alerts: …" / "[SMS] Mom: …"
      const groupInfo = isGroup && item.group_name ? ` in ${item.group_name}` : '';
      const botTag = author.isBot ? ' (bot)' : '';
      await insertSystemMessage(
        pgPool,
        userId,
        `[${appLabel(item.app)}] ${speakerName}${botTag}${groupInfo}: "${truncBody}"`,
        undefined, // notify
        undefined, // schedulerEvent
        buildSourceRouting({
          platform: item.app,
          remoteJid: convKey,
          senderName: author.authorName,
          contactName: speakerName,
          personId,
          fromMe: false,
          isGroup,
          groupName: item.group_name,
        }),
      );

      await es.update({ index: 'll5_awareness_messages', id: docId, doc: { processed: true }, refresh: false });
      logger.info('[message][processMessage] Immediate notification sent', { author: speakerName, app: item.app, person_id: personId ?? null });
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
  entityName: string,
): Promise<void> {
  try {
    // Deterministic ID: same entity always overwrites its status
    const entityId = crypto
      .createHash('sha256')
      .update(`${userId}:${entityName.toLowerCase()}`)
      .digest('hex')
      .slice(0, 20);

    const statusDoc: Record<string, unknown> = {
      user_id: userId,
      entity_name: entityName,
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
      entity_name: entityName,
      source: item.app,
    });
  } catch (err) {
    // Entity status update is non-critical — log and continue
    logger.warn('[message][updateEntityStatus] Failed to update entity status', {
      error: err instanceof Error ? err.message : String(err),
      entity_name: entityName,
    });
  }
}
