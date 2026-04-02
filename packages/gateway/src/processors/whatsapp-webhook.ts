import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import type { NotificationRuleMatcher } from './notification-rules.js';

interface EvolutionMessageData {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  pushName?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
  };
  messageTimestamp?: number | string;
}

interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  data: EvolutionMessageData;
}

export async function processWhatsAppWebhook(
  es: Client,
  pgPool: Pool,
  matcher: NotificationRuleMatcher,
  userId: string,
  payload: EvolutionWebhookPayload,
): Promise<void> {
  // Only process messages.upsert
  if (payload.event !== 'messages.upsert') {
    logger.debug('[processWhatsAppWebhook][handle] Skipping non-message event', { event: payload.event });
    return;
  }

  const data = payload.data;
  const fromMe = data.key.fromMe;

  // Extract message text
  const text = data.message?.conversation
    ?? data.message?.extendedTextMessage?.text
    ?? '';

  if (!text) {
    logger.debug('[processWhatsAppWebhook][handle] Skipping message with no text content');
    return;
  }

  // Extract sender info
  const remoteJid = data.key.remoteJid;
  const isGroup = remoteJid.endsWith('@g.us');
  const sender = fromMe ? '(me)' : (data.pushName ?? remoteJid.split('@')[0]);
  const groupName = isGroup ? remoteJid : null; // TODO: resolve group name
  const timestamp = typeof data.messageTimestamp === 'number'
    ? new Date(data.messageTimestamp * 1000).toISOString()
    : new Date().toISOString();

  // Write to ES — same index as phone-pushed messages
  const docId = crypto.randomUUID();
  const messageDoc = {
    user_id: userId,
    sender,
    app: 'whatsapp',
    content: text,
    is_group: isGroup,
    group_name: groupName,
    processed: fromMe, // outbound messages are immediately marked processed (no batch/notification)
    from_me: fromMe,
    timestamp,
    source: 'evolution',
  };

  await es.index({
    index: 'll5_awareness_messages',
    id: docId,
    document: messageDoc,
    refresh: false,
  });

  logger.info('[processWhatsAppWebhook][handle] WhatsApp message received', {
    sender,
    isGroup,
    fromMe,
    bodyLength: text.length,
  });

  // Outbound messages: check notification rules for the conversation (user's side of the chat)
  if (fromMe) {
    const priority = await matcher.match(userId, {
      sender: '(me)',
      app: 'whatsapp',
      body: text,
      is_group: isGroup,
      group_name: groupName,
      platform: 'whatsapp',
      conversation_id: remoteJid,
    });

    // Only notify agent for conversations with immediate or agent priority
    if (priority === 'immediate' || priority === 'agent') {
      const truncBody = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
      const groupInfo = isGroup && groupName ? ` (group: ${groupName})` : '';
      await insertSystemMessage(
        pgPool,
        userId,
        `[WhatsApp] You sent${groupInfo}: "${truncBody}"`,
      );

      await es.update({
        index: 'll5_awareness_messages',
        id: docId,
        doc: { processed: true },
        refresh: false,
      });

      logger.info('[processWhatsAppWebhook][handle] Outbound message notified to agent', { isGroup, priority });
    }
    return;
  }

  // Update entity status
  try {
    const entityId = crypto.createHash('sha256')
      .update(`${userId}:${sender.toLowerCase()}`)
      .digest('hex').slice(0, 20);

    await es.index({
      index: 'll5_awareness_entity_statuses',
      id: entityId,
      document: {
        user_id: userId,
        entity_name: sender,
        summary: text,
        source: 'whatsapp',
        timestamp,
      },
      refresh: false,
    });
  } catch (err) {
    logger.warn('[processWhatsAppWebhook][handle] Failed to update entity status', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Check notification rules (conversation-specific rules checked first)
  const priority = await matcher.match(userId, {
    sender,
    app: 'whatsapp',
    body: text,
    is_group: isGroup,
    group_name: groupName,
    platform: 'whatsapp',
    conversation_id: remoteJid,
  });

  logger.info('[processWhatsAppWebhook][handle] Notification rule match', {
    sender,
    priority: priority ?? 'no-match',
  });

  if (priority === 'ignore') {
    // Mark as processed so batch review skips it
    await es.update({
      index: 'll5_awareness_messages',
      id: docId,
      doc: { processed: true },
      refresh: false,
    });
    logger.debug('[processWhatsAppWebhook][handle] Ignored message marked processed', { sender });
    return;
  }

  if (priority === 'immediate' || priority === 'agent') {
    const truncBody = text.length > 200 ? text.slice(0, 200) + '...' : text;
    const groupInfo = isGroup && groupName ? ` (group: ${groupName})` : '';
    // No FCM notify — immediate WhatsApp goes to agent via system message → SSE only
    await insertSystemMessage(
      pgPool,
      userId,
      `[WhatsApp] ${sender}${groupInfo}: "${truncBody}"`,
    );

    // Mark as processed so batch review doesn't re-report it
    await es.update({
      index: 'll5_awareness_messages',
      id: docId,
      doc: { processed: true },
      refresh: false,
    });

    logger.info('[processWhatsAppWebhook][handle] Immediate notification sent', { sender });
  }
}
