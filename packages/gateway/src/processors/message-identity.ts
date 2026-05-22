import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import type { SourceRoutingMeta } from '../utils/system-message.js';

/**
 * Shared message-identity helpers used by BOTH the WhatsApp webhook
 * (`whatsapp-webhook.ts`) and the phone-mirrored message processor
 * (`message.ts`). The goal is one source of truth for: parsing the real
 * author out of a notification, resolving+enriching the messaging_contacts
 * row, and building the SourceRoutingMeta the agent reasons about — so Slack /
 * SMS / Gmail get the same identity quality WhatsApp already has.
 */

const BOT_SUFFIX = /\s*\(bot\)\s*$/i;

export interface ParsedAuthor {
  /** Clean display name of the actual message author (no channel prefix / bot tag). */
  authorName: string;
  /** messaging_contacts.platform_id for the author (what we resolve/enrich on). */
  authorId: string;
  /** True when the author is a bot/integration (Slack "(bot)"), for filtering. */
  isBot: boolean;
  /** Normalized phone number when the sender is a bare number (SMS short-codes). */
  phoneNumber: string | null;
}

/**
 * Parse the real author out of a phone-notification `sender`.
 *
 * Per-platform shapes (grounded in live ll5_awareness_messages data):
 *  - Slack  : `sender = "#channel: Author (bot)"`, `group_name = "#channel"`.
 *             The channel is redundant with group_name → strip the prefix to
 *             get the author; a trailing `(bot)` marks integrations (Opsgenie).
 *  - SMS    : `sender` is the contact name OR a bare number/short-code.
 *  - Gmail  : `sender` is the email author display name; `group_name` is the
 *             user's own account address. Already clean.
 *  - other  : treat `sender` as the author verbatim.
 */
export function parseMessageAuthor(
  platform: string,
  rawSender: string,
  groupName: string | null | undefined,
  _isGroup: boolean,
): ParsedAuthor {
  const p = platform.toLowerCase();
  let name = rawSender.trim();

  // Slack packs the channel into the notification title: "#channel: Author".
  // Strip the redundant "<channel>: " prefix (it duplicates group_name).
  if (p === 'slack' && name.includes(': ')) {
    const idx = name.indexOf(': ');
    const prefix = name.slice(0, idx);
    const norm = (s: string) => s.replace(/^#/, '').trim().toLowerCase();
    if (!groupName || norm(prefix) === norm(groupName) || prefix.startsWith('#')) {
      name = name.slice(idx + 2).trim();
    }
  }

  // Bot marker (Slack integrations): "Opsgenie (bot)" → bot, name "Opsgenie".
  let isBot = false;
  if (BOT_SUFFIX.test(name)) {
    isBot = true;
    name = name.replace(BOT_SUFFIX, '').trim();
  }

  // Bare phone-number / short-code senders → capture a normalized phone number.
  let phoneNumber: string | null = null;
  const compact = name.replace(/[\s-]/g, '');
  if (/^\+?\d{3,}$/.test(compact)) {
    phoneNumber = compact.startsWith('+') ? compact : `+${compact}`;
  }

  const finalName = name || rawSender;
  return { authorName: finalName, authorId: finalName, isBot, phoneNumber };
}

export interface EnrichResult {
  personId: string | null;
  displayName: string;
}

/**
 * Upsert + resolve a contact in the cross-platform `messaging_contacts` table
 * (keyed `UNIQUE(user_id, platform, platform_id)`), returning the linked
 * person_id and the best display name. Used by both processors.
 *
 * The display_name CASE only overwrites placeholder values (null / empty /
 * bare number / WhatsApp JID) so a curated name is never clobbered by a worse
 * one. `last_seen_at` always advances so repeat senders are tracked.
 *
 * NOTE: param order is `[userId, platformId, displayName, phoneNumber,
 * isGroup, platform]` deliberately — keeping platformId at $2 and displayName
 * at $3 preserves the WhatsApp enrichment tests that assert those positions.
 */
export async function enrichContact(
  pool: Pool,
  userId: string,
  platform: string,
  platformId: string,
  displayName: string,
  opts: { phoneNumber?: string | null; isGroup?: boolean } = {},
): Promise<EnrichResult> {
  try {
    const r = await pool.query<{ person_id: string | null; display_name: string | null }>(
      `INSERT INTO messaging_contacts
         (user_id, platform, platform_id, display_name, phone_number, is_group, last_seen_at)
       VALUES ($1, $6, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, platform, platform_id)
       DO UPDATE SET
         display_name = CASE
           WHEN messaging_contacts.display_name IS NULL
             OR messaging_contacts.display_name = ''
             OR messaging_contacts.display_name ~ '^\\+?[0-9]+$'
             OR messaging_contacts.display_name LIKE '%@s.whatsapp.net'
             OR messaging_contacts.display_name LIKE '%@lid'
           THEN EXCLUDED.display_name
           ELSE messaging_contacts.display_name
         END,
         phone_number = COALESCE(EXCLUDED.phone_number, messaging_contacts.phone_number),
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING person_id, display_name`,
      [userId, platformId, displayName, opts.phoneNumber ?? null, opts.isGroup ?? false, platform],
    );
    return {
      personId: r.rows[0]?.person_id ?? null,
      displayName: r.rows[0]?.display_name || displayName,
    };
  } catch (err) {
    logger.warn('[message-identity][enrichContact] contact resolve failed (non-critical)', {
      error: err instanceof Error ? err.message : String(err),
      platform,
    });
    return { personId: null, displayName };
  }
}

/** Build the SourceRoutingMeta the agent uses to know exactly who/where. */
export function buildSourceRouting(args: {
  platform: string;
  remoteJid: string;
  senderName: string;
  contactName?: string | null;
  personId?: string | null;
  fromMe: boolean;
  isGroup: boolean;
  groupName?: string | null;
}): SourceRoutingMeta {
  return {
    platform: args.platform,
    remote_jid: args.remoteJid,
    sender_name: args.senderName,
    contact_name: args.contactName || undefined,
    person_id: args.personId ?? undefined,
    from_me: args.fromMe,
    is_group: args.isGroup,
    group_name: args.groupName ?? undefined,
  };
}
