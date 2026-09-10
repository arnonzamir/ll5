import type { Pool } from 'pg';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import { getConversationPriority } from './permission-checker.js';
import { checkLl5Prefix } from './ll5-prefix.js';
import { logAudit } from '@ll5/shared';

export interface WhatsAppAccount {
  api_url: string;
  instance_name: string;
  api_key: string;
  status: string;
}

export interface SendGateInput {
  userId: string;
  accountId: string;
  to: string;
  /** The text that carries the [LL5] identity prefix — message body, or media caption. */
  identityText: string;
  confirmed?: boolean;
}

export type SendGateResult =
  | { ok: true; account: WhatsAppAccount; conversationId: string; hasConversation: boolean }
  | { ok: false; payload: Record<string, unknown>; isError: boolean };

/**
 * Every pre-send check a contact-bound WhatsApp send must pass, in order:
 * [LL5] prefix, account exists + connected, conversation permission, first-contact
 * approval. Shared by send_whatsapp and send_whatsapp_media so the two can never
 * drift apart on a safety gate.
 */
export async function runWhatsAppSendGates(
  input: SendGateInput,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  pool: Pool,
): Promise<SendGateResult> {
  const { userId, accountId, to } = input;

  const prefix = checkLl5Prefix(input.identityText);
  if (!prefix.ok) {
    logAudit({
      user_id: userId,
      source: 'messaging',
      action: 'send_rejected_no_prefix',
      entity_type: 'whatsapp_message',
      entity_id: to,
      summary: `Rejected WhatsApp message to ${to} — missing [LL5] prefix`,
      metadata: { account_id: accountId, to, reason: 'missing_ll5_prefix' },
    });
    return {
      ok: false,
      isError: false,
      payload: { sent: false, rejected: 'missing_ll5_prefix', correction: prefix.correction },
    };
  }

  const account = await accountRepo.getWhatsApp(userId, accountId);
  if (!account) {
    return { ok: false, isError: true, payload: { error: 'ACCOUNT_NOT_FOUND' } };
  }
  if (account.status !== 'connected') {
    return { ok: false, isError: true, payload: { error: 'ACCOUNT_DISCONNECTED', status: account.status } };
  }

  const conversationId = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  const priority = await getConversationPriority(pool, userId, 'whatsapp', conversationId);
  if (priority !== 'agent') {
    return {
      ok: false,
      isError: true,
      payload: {
        error: 'PERMISSION_DENIED',
        priority: priority ?? 'no-rule',
        message: 'Only conversations with "agent" priority can receive messages',
      },
    };
  }

  const conversation = await conversationRepo.get(userId, 'whatsapp', conversationId);

  // First-contact send-gate: a first message to a recipient the agent has never
  // messaged before must be explicitly approved by the user.
  // TODO(follow-up): make this non-bypassable — gate on a real user-approval
  // record (user approves in-app) rather than trusting the agent to set
  // confirmed:true. Today this is pragmatic enforcement at the tool layer.
  const priorSends = await accountRepo.countSentToRecipient(userId, 'whatsapp', to);
  if (priorSends === 0 && input.confirmed !== true) {
    logAudit({
      user_id: userId,
      source: 'messaging',
      action: 'send_blocked',
      entity_type: 'whatsapp_message',
      entity_id: to,
      summary: `Blocked first-contact WhatsApp message to ${to} (needs approval)`,
      metadata: { account_id: accountId, to, reason: 'first_contact_needs_approval' },
    });
    return {
      ok: false,
      isError: false,
      payload: {
        sent: false,
        blocked: 'first_contact_needs_approval',
        message: `First message to ${to} — get the user's explicit approval, then resend with confirmed:true.`,
      },
    };
  }

  return { ok: true, account, conversationId, hasConversation: conversation != null };
}
