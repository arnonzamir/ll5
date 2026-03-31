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
    logger.debug('[processWhatsAppWebhook] Skipping non-message event', { event: payload.event });
    return;
  }

  const data = payload.data;

  // Skip messages sent by us
  if (data.key.fromMe) {
    logger.debug('[processWhatsAppWebhook] Skipping outbound message');
    return;
  }

  // Extract message text
  const text = data.message?.conversation
    ?? data.message?.extendedTextMessage?.text
    ?? '';

  if (!text) {
    logger.debug('[processWhatsAppWebhook] Skipping message with no text content');
    return;
  }

  // Extract sender info
  const remoteJid = data.key.remoteJid;
  const isGroup = remoteJid.endsWith('@g.us');
  const sender = data.pushName ?? remoteJid.split('@')[0];
  const groupName = isGroup ? remoteJid : null; // TODO: resolve group name
  const timestamp = typeof data.messageTimestamp === 'number'
    ? new Date(data.messageTimestamp * 1000).toISOString()
    : new Date().toISOString();

  // Write to ES — same index as phone-pushed messages
  const messageDoc = {
    user_id: userId,
    sender,
    app: 'whatsapp',
    content: text,
    is_group: isGroup,
    group_name: groupName,
    processed: false,
    timestamp,
    source: 'evolution', // distinguish from phone-pushed
  };

  await es.index({
    index: 'll5_awareness_messages',
    id: crypto.randomUUID(),
    document: messageDoc,
    refresh: false,
  });

  logger.info('[processWhatsAppWebhook] WhatsApp message received', {
    sender,
    isGroup,
    bodyLength: text.length,
  });

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
    logger.warn('[processWhatsAppWebhook] Failed to update entity status', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Check notification rules
  const priority = await matcher.match(userId, {
    sender,
    app: 'whatsapp',
    body: text,
    is_group: isGroup,
    group_name: groupName,
  });

  logger.info('[processWhatsAppWebhook] Notification rule match', {
    sender,
    priority: priority ?? 'no-match',
  });

  if (priority === 'immediate') {
    const truncBody = text.length > 200 ? text.slice(0, 200) + '...' : text;
    const groupInfo = isGroup && groupName ? ` (group: ${groupName})` : '';
    await insertSystemMessage(
      pgPool,
      userId,
      `[WhatsApp] ${sender}${groupInfo}: "${truncBody}"`,
      {
        title: 'WhatsApp',
        type: 'whatsapp',
        priority: 'high',
      },
    );
    logger.info('[processWhatsAppWebhook] Immediate notification sent', { sender });
  }
}
