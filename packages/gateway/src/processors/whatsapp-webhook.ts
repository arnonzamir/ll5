import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
import { escalateConversation } from '../utils/escalation.js';
import { decrypt } from '../utils/encryption.js';
import { buildSourceRouting, enrichContact } from './message-identity.js';
import type { ContactRoutingResolver } from './contact-routing.js';

const UPLOAD_DIR = process.env.NODE_ENV === 'production' ? '/app/uploads' : './uploads';

/**
 * Enrich a WhatsApp contact's display_name from pushName.
 * Computes the phone number from the JID and applies the WhatsApp-specific
 * guards (skip self-named numbers and group JIDs), then delegates the upsert
 * to the shared `enrichContact` helper (same table/logic phone apps use).
 */
async function enrichContactFromPushName(
  pgPool: Pool,
  userId: string,
  platformId: string,
  pushName: string,
): Promise<void> {
  const phonePart = platformId.split('@')[0];
  if (pushName === phonePart) return;

  const isLid = platformId.endsWith('@lid');
  const isGroupJid = platformId.endsWith('@g.us');
  if (isGroupJid) return;

  let phoneNumber: string | null = null;
  if (!isLid && /^\d+$/.test(phonePart)) {
    phoneNumber = `+${phonePart}`;
  }

  await enrichContact(pgPool, userId, 'whatsapp', platformId, pushName, { phoneNumber, isGroup: false });
}

/** Quoted-reply context (WhatsApp reply-to). quotedMessage carries the ORIGINAL
 *  message being replied to; participant is the quoted author's JID. Without
 *  extracting this, a contact replying to one of the agent's own [LL5] messages
 *  looked like a free-floating message (2026-07-04 finding). */
interface EvolutionContextInfo {
  stanzaId?: string;
  participant?: string;
  quotedMessage?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { fileName?: string };
  };
}

interface EvolutionMessageData {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
    participant?: string;      // sender JID in group messages (@lid or @s.whatsapp.net)
    participantAlt?: string;   // alternative JID (e.g., @s.whatsapp.net when participant is @lid)
  };
  pushName?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string; contextInfo?: EvolutionContextInfo };
    imageMessage?: {
      url?: string;
      directPath?: string;
      mimetype?: string;
      caption?: string;
      mediaKey?: string;
      contextInfo?: EvolutionContextInfo;
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
  matcher: ContactRoutingResolver,
  userId: string,
  payload: EvolutionWebhookPayload,
  encryptionKey?: string,
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

  // Quoted-reply context: when this message is a WhatsApp reply, surface WHAT it
  // replies to — otherwise an answer to one of the agent's own [LL5] messages is
  // indistinguishable from a new thought.
  const contextInfo = data.message?.extendedTextMessage?.contextInfo
    ?? data.message?.imageMessage?.contextInfo;
  const quoted = contextInfo?.quotedMessage;
  const quotedTextRaw = quoted?.conversation
    ?? quoted?.extendedTextMessage?.text
    ?? quoted?.imageMessage?.caption
    ?? quoted?.videoMessage?.caption
    ?? quoted?.documentMessage?.fileName
    ?? (quoted ? '[media]' : null);
  const quotedInfo = quotedTextRaw
    ? ` [replying to: «${quotedTextRaw.length > 150 ? quotedTextRaw.slice(0, 150) + '...' : quotedTextRaw}»]`
    : '';

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
      'SELECT name FROM messaging_conversations WHERE user_id = $1 AND conversation_id = $2 AND name IS NOT NULL LIMIT 1',
      [userId, remoteJid],
    );
    conversationName = nameResult.rows[0]?.name ?? null;
    if (isGroup) {
      groupName = conversationName ?? remoteJid;
    }
  } catch {
    if (isGroup) groupName = remoteJid;
  }

  // Resolve the conversation PEER to a known person + display name via
  // messaging_contacts. For a 1:1, remote_jid is the peer whether the message is
  // inbound or fromMe — so this also identifies the RECIPIENT of outbound
  // messages, which the agent needs to answer "who did I message?".
  let personId: string | null = null;
  let contactDisplayName: string | null = null;
  if (!isGroup) {
    try {
      const contactResult = await pgPool.query(
        "SELECT person_id, display_name FROM messaging_contacts WHERE user_id = $1 AND platform = 'whatsapp' AND platform_id = $2 LIMIT 1",
        [userId, remoteJid],
      );
      personId = contactResult.rows[0]?.person_id ?? null;
      contactDisplayName = contactResult.rows[0]?.display_name ?? null;
    } catch {
      // Non-critical — fall back to name-based matching
    }
  }

  // The peer name the agent reasons about: contact display name > conversation
  // name > inbound sender > bare JID. For a group, the peer is the group.
  const peerName: string = isGroup
    ? (groupName ?? remoteJid)
    : (contactDisplayName || conversationName || (!fromMe ? sender : '') || remoteJid.split('@')[0]);

  // Enrich contact display_name from pushName (both 1:1 and group senders)
  const pushName = data.pushName;
  if (pushName && !fromMe) {
    const senderJid = isGroup ? data.key.participant : remoteJid;
    if (senderJid) {
      await enrichContactFromPushName(pgPool, userId, senderJid, pushName);
      // If participant is @lid and participantAlt provides @s.whatsapp.net, enrich that too
      const altJid = data.key.participantAlt;
      if (altJid && altJid !== senderJid) {
        await enrichContactFromPushName(pgPool, userId, altJid, pushName);
      }
    }
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
    const shouldDownload = await matcher.shouldDownloadMedia(userId, 'whatsapp', remoteJid, isGroup, personId);
    if (shouldDownload) {
      try {
        // Tenant-scoped: only this user's Evolution credentials may be used to
        // download their inbound media. ORDER BY makes the single-row pick
        // deterministic when a tenant has more than one account row.
        const evoAccount = await pgPool.query(
          'SELECT api_url, api_key, instance_name FROM messaging_whatsapp_accounts WHERE user_id = $1 ORDER BY instance_name LIMIT 1',
          [userId],
        );
        const evo = evoAccount.rows[0];
        logger.debug('[processWhatsAppWebhook][handle] Evolution account lookup', {
          userId,
          found: !!evo,
        });
        let buf: Buffer | null = null;

        if (evo) {
          try {
            // api_key is stored encrypted in DB — decrypt before use
            let apiKey = evo.api_key;
            if (encryptionKey) {
              try {
                apiKey = decrypt(evo.api_key, encryptionKey);
              } catch (decryptErr) {
                logger.warn('[processWhatsAppWebhook][handle] Failed to decrypt API key, using raw value', {
                  error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
                });
              }
            }
            const mediaRes = await fetch(
              `${evo.api_url}/chat/getBase64FromMediaMessage/${evo.instance_name}`,
              {
                method: 'POST',
                headers: {
                  'apikey': apiKey,
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
          const filename = `wa_${prefix}_${userId.slice(0, 8)}_${Date.now()}_${crypto.randomBytes(16).toString('hex')}.${ext}`;
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

  // The name stored on the message doc, so name/person-based thread lookups
  // (read_messages, get_person) correlate it to the right contact/thread.
  // For a 1:1 this is the PEER (= recipient for outbound, sender for inbound):
  // contact display name > conversation name > inbound sender > bare JID. For a
  // group it is the group name. Crucially this resolves the recipient on
  // outbound (fromMe) docs the same way inbound docs are resolved, instead of
  // leaving conversation_name null when there is no messaging_conversations row.
  const messageConversationName: string | null = isGroup
    ? (conversationName ?? groupName)
    : (contactDisplayName || conversationName || (!fromMe ? sender : null));

  // Write to ES — same index as phone-pushed messages
  const docId = crypto.randomUUID();
  const messageDoc: Record<string, unknown> = {
    user_id: userId,
    sender,
    app: 'whatsapp',
    content: text || (hasImage ? '[image]' : ''),
    is_group: isGroup,
    group_name: groupName,
    conversation_id: remoteJid,
    conversation_name: messageConversationName,
    processed: fromMe,
    from_me: fromMe,
    timestamp,
    source: 'evolution',
    ...(personId ? { person_id: personId } : {}),
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
      person_id: personId ?? undefined,
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
      const mediaInfo = hasMedia && mediaUrl ? ` [${mediaType} attached: ${mediaUrl}${mediaDurationSec ? ` (${mediaDurationSec}s)` : ''}]` : hasMedia ? ` [${mediaType} attached]` : '';
      // Name the recipient so the agent knows exactly who the user messaged, and
      // attach source routing (peer name + person_id + from_me) for context.
      const dest = isGroup ? `group: ${groupName ?? remoteJid}` : peerName;
      await insertSystemMessage(
        pgPool,
        userId,
        `[WhatsApp] You → ${dest}: "${truncBody}"${mediaInfo}${quotedInfo}`,
        undefined, // notify
        undefined, // schedulerEvent
        buildSourceRouting({
          platform: 'whatsapp',
          remoteJid,
          senderName: '(me)',
          contactName: peerName,
          personId,
          fromMe: true,
          isGroup,
          groupName,
        }),
      );

      await es.update({
        index: 'll5_awareness_messages',
        id: docId,
        doc: { processed: true },
        refresh: false,
      });

      logger.info('[processWhatsAppWebhook][handle] Outbound message notified to agent', { isGroup, priority, to: dest });
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

  // Check notification rules (contact_settings → conversation → pattern → wildcard)
  const priority = await matcher.match(userId, {
    sender,
    app: 'whatsapp',
    body: text,
    is_group: isGroup,
    group_name: groupName,
    platform: 'whatsapp',
    conversation_id: remoteJid,
    person_id: personId ?? undefined,
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
    const mediaInfo = hasMedia && mediaUrl ? ` [${mediaType} attached: ${mediaUrl}${mediaDurationSec ? ` (${mediaDurationSec}s)` : ''}]` : hasMedia ? ` [${mediaType} attached]` : '';
    // Inbound only (fromMe returns earlier). Header = sender (+ group context).
    const header = `${sender}${isGroup && groupName ? ` (group: ${groupName})` : ''}`;
    // No FCM notify — immediate WhatsApp goes to agent via system message → SSE only
    await insertSystemMessage(
      pgPool,
      userId,
      `[WhatsApp] ${header}: "${truncBody}"${mediaInfo}${quotedInfo}`,
      undefined, // notify
      undefined, // schedulerEvent
      buildSourceRouting({
        platform: 'whatsapp',
        remoteJid,
        senderName: sender,
        contactName: peerName,
        personId,
        fromMe,
        isGroup,
        groupName,
      }),
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
