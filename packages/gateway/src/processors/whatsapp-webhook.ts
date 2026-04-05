import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import { escalateConversation } from '../utils/escalation.js';
import type { NotificationRuleMatcher } from './notification-rules.js';

const UPLOAD_DIR = process.env.NODE_ENV === 'production' ? '/app/uploads' : './uploads';

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
    imageMessage?: {
      url?: string;
      directPath?: string;
      mimetype?: string;
      caption?: string;
      mediaKey?: string;
    };
    audioMessage?: {
      url?: string;
      mimetype?: string;
      seconds?: number;
      ptt?: boolean; // true = voice note, false = audio file
      mediaKey?: string;
    };
    videoMessage?: {
      url?: string;
      mimetype?: string;
      seconds?: number;
      caption?: string;
      mediaKey?: string;
    };
    documentMessage?: {
      url?: string;
      mimetype?: string;
      fileName?: string;
      mediaKey?: string;
    };
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

  // Extract message text + detect media
  const text = data.message?.conversation
    ?? data.message?.extendedTextMessage?.text
    ?? data.message?.imageMessage?.caption
    ?? data.message?.videoMessage?.caption
    ?? '';
  const imageMessage = data.message?.imageMessage;
  const audioMessage = data.message?.audioMessage;
  const videoMessage = data.message?.videoMessage;
  const documentMessage = data.message?.documentMessage;
  const hasImage = !!imageMessage;
  const hasAudio = !!audioMessage;
  const hasVideo = !!videoMessage;
  const hasDocument = !!documentMessage;
  const hasMedia = hasImage || hasAudio || hasVideo || hasDocument;

  if (!text && !hasMedia) {
    logger.debug('[processWhatsAppWebhook][handle] Skipping message with no text or media content');
    return;
  }

  // Extract sender info
  const remoteJid = data.key.remoteJid;
  const isGroup = remoteJid.endsWith('@g.us');
  const sender = fromMe ? '(me)' : (data.pushName ?? remoteJid.split('@')[0]);

  // Resolve group/conversation name from messaging DB (shared PG)
  let groupName: string | null = null;
  let conversationName: string | null = null;
  try {
    const nameResult = await pgPool.query(
      'SELECT name FROM messaging_conversations WHERE conversation_id = $1 AND name IS NOT NULL LIMIT 1',
      [remoteJid],
    );
    conversationName = nameResult.rows[0]?.name ?? null;
    if (isGroup) {
      groupName = conversationName ?? remoteJid;
    }
  } catch {
    if (isGroup) groupName = remoteJid;
  }

  // Determine media type and metadata
  const activeMedia = imageMessage ?? audioMessage ?? videoMessage ?? documentMessage;
  const mediaType = hasImage ? 'image' : hasAudio ? (audioMessage?.ptt ? 'voice_note' : 'audio') : hasVideo ? 'video' : hasDocument ? 'document' : null;
  const mediaMimetype = activeMedia?.mimetype ?? (hasImage ? 'image/jpeg' : hasAudio ? 'audio/ogg' : hasVideo ? 'video/mp4' : 'application/octet-stream');
  const mediaDurationSec = (audioMessage?.seconds ?? videoMessage?.seconds) || undefined;

  // Download media if conversation has download_images enabled
  let mediaUrl: string | null = null;
  let mediaId: string | null = null;
  if (hasMedia && activeMedia) {
    const shouldDownload = await matcher.shouldDownloadImages(userId, 'whatsapp', remoteJid);
    if (shouldDownload) {
      try {
        const evoAccount = await pgPool.query(
          'SELECT api_url, api_key, instance_name FROM messaging_whatsapp_accounts LIMIT 1',
        );
        const evo = evoAccount.rows[0];
        let buf: Buffer | null = null;

        if (evo) {
          try {
            const mediaRes = await fetch(
              `${evo.api_url}/chat/getBase64FromMediaMessage/${evo.instance_name}`,
              {
                method: 'POST',
                headers: {
                  'apikey': evo.api_key,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message: data }),
              },
            );
            if (mediaRes.ok) {
              const mediaData = await mediaRes.json() as { base64?: string };
              if (mediaData.base64) {
                buf = Buffer.from(mediaData.base64, 'base64');
                logger.info('[processWhatsAppWebhook][handle] Media downloaded via Evolution API', { type: mediaType, size: buf.length });
              } else {
                logger.warn('[processWhatsAppWebhook][handle] Evolution getBase64 returned no base64 field', { keys: Object.keys(mediaData) });
              }
            } else {
              const errBody = await mediaRes.text().catch(() => '');
              logger.warn('[processWhatsAppWebhook][handle] Evolution getBase64 failed', { status: mediaRes.status, body: errBody.slice(0, 200) });
            }
          } catch (evoErr) {
            logger.warn('[processWhatsAppWebhook][handle] Evolution media download failed', {
              error: evoErr instanceof Error ? evoErr.message : String(evoErr),
            });
          }
        }

        if (buf && buf.length > 0) {
          const ext = mediaMimetype.split('/')[1]?.replace('codecs', '').replace(/[^a-z0-9]/g, '') || 'bin';
          const prefix = mediaType === 'voice_note' ? 'vn' : mediaType ?? 'media';
          const filename = `wa_${prefix}_${userId.slice(0, 8)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
          const filePath = path.join(UPLOAD_DIR, filename);
          fs.writeFileSync(filePath, buf);
          mediaUrl = `/uploads/${filename}`;

          const mediaResult = await es.index({
            index: 'll5_media',
            document: {
              user_id: userId,
              url: mediaUrl,
              mime_type: mediaMimetype,
              filename,
              size_bytes: buf.length,
              source: 'whatsapp',
              media_type: mediaType,
              duration_seconds: mediaDurationSec,
              tags: isGroup && groupName ? [groupName] : [],
              created_at: new Date().toISOString(),
            },
          });
          mediaId = mediaResult._id;
          logger.info('[processWhatsAppWebhook][handle] WhatsApp media saved', { type: mediaType, filename, size: buf.length });
        }
      } catch (err) {
        logger.warn('[processWhatsAppWebhook][handle] Failed to download WhatsApp media', {
          error: err instanceof Error ? err.message : String(err),
          mediaType,
        });
      }
    } else {
      logger.debug('[processWhatsAppWebhook][handle] Skipping media download — download_images not enabled');
    }
  }
  const timestamp = typeof data.messageTimestamp === 'number'
    ? new Date(data.messageTimestamp * 1000).toISOString()
    : new Date().toISOString();

  // Write to ES — same index as phone-pushed messages
  const docId = crypto.randomUUID();
  const messageDoc: Record<string, unknown> = {
    user_id: userId,
    sender,
    app: 'whatsapp',
    content: text || (hasImage ? '[image]' : ''),
    is_group: isGroup,
    group_name: groupName,
    processed: fromMe,
    from_me: fromMe,
    timestamp,
    source: 'evolution',
  };
  if (mediaUrl) {
    messageDoc.media_url = mediaUrl;
    messageDoc.media_id = mediaId;
    messageDoc.media_type = mediaType;
    if (mediaDurationSec) messageDoc.media_duration_seconds = mediaDurationSec;
  }

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

    // Escalate if user is writing in an ignored/batched conversation
    if (priority === 'ignore' || priority === 'batch') {
      await escalateConversation(
        pgPool, es, userId, 'whatsapp', remoteJid,
        conversationName ?? groupName ?? remoteJid.split('@')[0],
        priority,
      );
      await es.update({
        index: 'll5_awareness_messages',
        id: docId,
        doc: { processed: true },
        refresh: false,
      });
      return;
    }

    // Notify agent for conversations with immediate or agent priority
    if (priority === 'immediate' || priority === 'agent') {
      const truncBody = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
      const groupInfo = isGroup && groupName ? ` (group: ${groupName})` : '';
      const mediaInfo = hasMedia && mediaUrl ? ` [${mediaType} attached: ${mediaUrl}${mediaDurationSec ? ` (${mediaDurationSec}s)` : ''}]` : hasMedia ? ` [${mediaType} attached]` : '';
      await insertSystemMessage(
        pgPool,
        userId,
        `[WhatsApp] You sent${groupInfo}: "${truncBody}"${mediaInfo}`,
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
    const mediaInfo = hasMedia && mediaUrl ? ` [${mediaType} attached: ${mediaUrl}${mediaDurationSec ? ` (${mediaDurationSec}s)` : ''}]` : hasMedia ? ` [${mediaType} attached]` : '';
    // No FCM notify — immediate WhatsApp goes to agent via system message → SSE only
    await insertSystemMessage(
      pgPool,
      userId,
      `[WhatsApp] ${sender}${groupInfo}: "${truncBody}"${mediaInfo}`,
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
