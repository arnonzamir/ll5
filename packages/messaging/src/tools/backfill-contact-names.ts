import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ContactRepository } from '../repositories/interfaces/contact.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { logger } from '../utils/logger.js';
import { logAudit } from '@ll5/shared';

/**
 * Extract a phone number from a WhatsApp JID.
 * E.g. "972501234567@s.whatsapp.net" → "+972501234567"
 */
function phoneFromJid(jid: string): string | null {
  if (jid.endsWith('@g.us') || jid.endsWith('@lid')) return null;
  const num = jid.split('@')[0];
  if (!num || !/^\d+$/.test(num)) return null;
  return `+${num}`;
}

export function registerBackfillContactNamesTool(
  server: McpServer,
  accountRepo: AccountRepository,
  contactRepo: ContactRepository,
  getUserId: () => string,
): void {
  server.tool(
    'backfill_contact_names',
    'Scan Evolution API message history to extract pushNames and enrich contacts that have no display name. One-time backfill, safe to re-run.',
    {
      account_id: z.string().describe('WhatsApp account UUID'),
    },
    async (params) => {
      const userId = getUserId();

      const account = await accountRepo.getWhatsApp(userId, params.account_id);
      if (!account) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_NOT_FOUND' }) }],
          isError: true,
        };
      }

      const client = new EvolutionClient(account.api_url, account.instance_name, account.api_key);

      // Scan all messages and collect latest pushName per sender JID
      const nameMap = new Map<string, { pushName: string; timestamp: number }>();
      let totalScanned = 0;
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        let result;
        try {
          result = await client.fetchMessagesPaginated(page, 500);
        } catch (err) {
          logger.warn('[backfillContactNames] Failed to fetch page', {
            page,
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }

        totalPages = result.pages;
        totalScanned += result.records.length;

        for (const msg of result.records) {
          if (msg.key.fromMe) continue;
          if (!msg.pushName || msg.pushName.trim() === '') continue;

          const ts = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : 0;

          // For group messages, sender is participant; for 1:1, sender is remoteJid
          const isGroup = msg.key.remoteJid.endsWith('@g.us');
          const senderJid = isGroup ? msg.key.participant : msg.key.remoteJid;

          if (senderJid && !senderJid.endsWith('@g.us')) {
            const existing = nameMap.get(senderJid);
            if (!existing || ts > existing.timestamp) {
              nameMap.set(senderJid, { pushName: msg.pushName, timestamp: ts });
            }
          }

          // Also track participantAlt (LID → phone JID mapping)
          const altJid = msg.key.participantAlt;
          if (altJid && altJid !== senderJid && !altJid.endsWith('@g.us')) {
            const existing = nameMap.get(altJid);
            if (!existing || ts > existing.timestamp) {
              nameMap.set(altJid, { pushName: msg.pushName, timestamp: ts });
            }
          }
        }

        if (page % 10 === 0) {
          logger.info('[backfillContactNames] Progress', {
            page,
            totalPages,
            messagesScanned: totalScanned,
            uniqueSenders: nameMap.size,
          });
        }

        page++;
      }

      logger.info('[backfillContactNames] Scan complete', {
        totalScanned,
        uniqueSenders: nameMap.size,
      });

      // Batch upsert contacts
      const contacts = Array.from(nameMap.entries())
        .filter(([jid, { pushName }]) => {
          const phonePart = jid.split('@')[0];
          return pushName !== phonePart;
        })
        .map(([jid, { pushName }]) => ({
          platform: 'whatsapp' as const,
          platform_id: jid,
          display_name: pushName,
          phone_number: phoneFromJid(jid) ?? undefined,
          is_group: false,
        }));

      let enriched = 0;
      const BATCH_SIZE = 100;
      for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
        const batch = contacts.slice(i, i + BATCH_SIZE);
        const count = await contactRepo.bulkUpsert(userId, batch);
        enriched += count;
      }

      logAudit({
        user_id: userId,
        source: 'messaging',
        action: 'backfill',
        entity_type: 'contact_names',
        entity_id: params.account_id,
        summary: `Backfilled contact names: ${enriched} contacts enriched from ${totalScanned} messages`,
        metadata: {
          messages_scanned: totalScanned,
          unique_senders: nameMap.size,
          contacts_enriched: enriched,
        },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            messages_scanned: totalScanned,
            unique_senders: nameMap.size,
            contacts_upserted: enriched,
          }, null, 2),
        }],
      };
    },
  );
}
