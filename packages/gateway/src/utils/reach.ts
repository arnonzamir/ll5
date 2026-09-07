import type { Pool } from 'pg';
import { logger } from './logger.js';
import { callMcpTool, userBearer } from './mcp-call.js';

/**
 * Reach rung (DECISION-034 §5 rung 3, Phase 2 of the ladder): a WhatsApp
 * message to the user's OWN number through the messaging MCP's
 * `send_whatsapp` — the self-chat the phone treats as a real conversation.
 *
 * Self JID resolution: `messaging_whatsapp_accounts` has no JID column; the
 * instance's own number is `phone_number` (nullable — it is set when the
 * account is created with one). The JID is `<digits>@s.whatsapp.net`. When
 * the account row has no number, `user_settings.settings.reach.whatsapp_jid`
 * (and optional `reach.account_id`) is the fallback.
 *
 * The messaging MCP's outbound gates still apply: the message must open with
 * `[LL5]` (checkLl5Prefix, non-bypassable), the self conversation must have
 * `contact_settings.permission = 'agent'`, and the first send to a new
 * recipient needs `confirmed:true` (the user's own number is not a new
 * contact in any meaningful sense, so the gateway passes it).
 */

export interface ReachConfig {
  messagingMcpUrl: string | undefined;
  authSecret: string;
}

export interface ReachTarget {
  account_id: string;
  jid: string;
  source: 'account_phone' | 'user_settings';
}

/** Pure: `<digits>@s.whatsapp.net` from a stored number, or null when it has fewer than 7 digits. */
export function selfJidFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.includes('@')) return phone;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 ? `${digits}@s.whatsapp.net` : null;
}

/** Pure: the reach text. `[LL5]` is the messaging MCP's mandatory outbound prefix. */
export function buildReachText(subject: string | null, firstLine: string, dueHHMM: string | null): string {
  const head = subject && firstLine && firstLine !== subject ? `${subject} — ${firstLine}` : (subject ?? firstLine);
  return `[LL5] LL5: ${head} (reach: unacknowledged${dueHHMM ? `, due ${dueHHMM}` : ''})`;
}

/** Pure: has this delivery already reached (never more than one per delivery)? */
export function reachAlreadySent(escalation: Record<string, unknown> | null | undefined): boolean {
  return typeof escalation?.reach_sent_at === 'string';
}

export async function resolveReachTarget(pool: Pool, userId: string): Promise<ReachTarget | null> {
  let accountId: string | null = null;
  let phone: string | null = null;
  try {
    const r = await pool.query<{ id: string; phone_number: string | null }>(
      `SELECT id, phone_number FROM messaging_whatsapp_accounts
        WHERE user_id = $1 AND status = 'connected'
        ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    accountId = r.rows[0]?.id ?? null;
    phone = r.rows[0]?.phone_number ?? null;
  } catch (err) {
    logger.warn('[reach][resolve] messaging_whatsapp_accounts unavailable', { userId, error: err instanceof Error ? err.message : String(err) });
  }
  const jid = selfJidFromPhone(phone);
  if (accountId && jid) return { account_id: accountId, jid, source: 'account_phone' };

  try {
    const s = await pool.query<{ jid: string | null; account_id: string | null }>(
      `SELECT settings->'reach'->>'whatsapp_jid' AS jid, settings->'reach'->>'account_id' AS account_id
         FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    const fallbackJid = selfJidFromPhone(s.rows[0]?.jid ?? null);
    const acct = s.rows[0]?.account_id ?? accountId;
    if (fallbackJid && acct) return { account_id: acct, jid: fallbackJid, source: 'user_settings' };
  } catch (err) {
    logger.warn('[reach][resolve] user_settings unavailable', { userId, error: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

export interface ReachResult {
  ok: boolean;
  target: ReachTarget | null;
  error?: string;
}

/** Send the self-WhatsApp. Never throws — the FCM reach rung has already gone out. */
export async function sendReachWhatsApp(pool: Pool, cfg: ReachConfig, userId: string, text: string): Promise<ReachResult> {
  if (!cfg.messagingMcpUrl) return { ok: false, target: null, error: 'messaging MCP url not configured' };
  const target = await resolveReachTarget(pool, userId);
  if (!target) return { ok: false, target: null, error: 'no self JID (no connected WhatsApp account with phone_number, no user_settings.reach.whatsapp_jid)' };
  try {
    const out = await callMcpTool(cfg.messagingMcpUrl, userBearer(userId, cfg.authSecret), 'send_whatsapp', {
      account_id: target.account_id, to: target.jid, message: text, confirmed: true,
    }) as Record<string, unknown> | null;
    if (out && (out.error || out.sent === false)) {
      const why = String(out.error ?? out.rejected ?? out.blocked ?? 'not sent');
      return { ok: false, target, error: why };
    }
    return { ok: true, target };
  } catch (err) {
    return { ok: false, target, error: err instanceof Error ? err.message : String(err) };
  }
}
