import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { runWhatsAppSendGates } from '../utils/send-gates.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';

vi.mock('@ll5/shared', () => ({ logAudit: vi.fn() }));

const getConversationPriority = vi.fn();
vi.mock('../utils/permission-checker.js', () => ({
  getConversationPriority: (...a: unknown[]) => getConversationPriority(...a),
}));

const CONNECTED = { api_url: 'https://evo', instance_name: 'll5', api_key: 'K', status: 'connected' };

function repos(overrides: {
  account?: unknown;
  priorSends?: number;
  conversation?: unknown;
} = {}) {
  const accountRepo = {
    getWhatsApp: vi.fn().mockResolvedValue(overrides.account === undefined ? CONNECTED : overrides.account),
    countSentToRecipient: vi.fn().mockResolvedValue(overrides.priorSends ?? 5),
  } as unknown as AccountRepository;
  const conversationRepo = {
    get: vi.fn().mockResolvedValue(overrides.conversation ?? { id: 'c1' }),
  } as unknown as ConversationRepository;
  return { accountRepo, conversationRepo, pool: {} as Pool };
}

const base = { userId: 'u1', accountId: 'a1', to: '972500000000', identityText: '[LL5] hello' };

describe('runWhatsAppSendGates', () => {
  beforeEach(() => {
    getConversationPriority.mockReset();
    getConversationPriority.mockResolvedValue('agent');
  });

  it('passes an established, permitted, prefixed send', async () => {
    const { accountRepo, conversationRepo, pool } = repos();
    const r = await runWhatsAppSendGates(base, accountRepo, conversationRepo, pool);
    expect(r).toMatchObject({ ok: true, conversationId: '972500000000@s.whatsapp.net', hasConversation: true });
  });

  it('rejects text without the [LL5] prefix before touching the account', async () => {
    const { accountRepo, conversationRepo, pool } = repos();
    const r = await runWhatsAppSendGates({ ...base, identityText: 'hello' }, accountRepo, conversationRepo, pool);
    expect(r).toMatchObject({ ok: false, payload: { rejected: 'missing_ll5_prefix' } });
    expect(accountRepo.getWhatsApp).not.toHaveBeenCalled();
  });

  it('refuses a disconnected account', async () => {
    const { accountRepo, conversationRepo, pool } = repos({ account: { ...CONNECTED, status: 'disconnected' } });
    const r = await runWhatsAppSendGates(base, accountRepo, conversationRepo, pool);
    expect(r).toMatchObject({ ok: false, payload: { error: 'ACCOUNT_DISCONNECTED' } });
  });

  it('refuses a missing account', async () => {
    const { accountRepo, conversationRepo, pool } = repos({ account: null });
    const r = await runWhatsAppSendGates(base, accountRepo, conversationRepo, pool);
    expect(r).toMatchObject({ ok: false, payload: { error: 'ACCOUNT_NOT_FOUND' } });
  });

  it('refuses a conversation that is not agent-permitted', async () => {
    getConversationPriority.mockResolvedValue('notify');
    const { accountRepo, conversationRepo, pool } = repos();
    const r = await runWhatsAppSendGates(base, accountRepo, conversationRepo, pool);
    expect(r).toMatchObject({ ok: false, payload: { error: 'PERMISSION_DENIED' } });
  });

  it('blocks a first contact unless confirmed', async () => {
    const { accountRepo, conversationRepo, pool } = repos({ priorSends: 0 });
    const blocked = await runWhatsAppSendGates(base, accountRepo, conversationRepo, pool);
    expect(blocked).toMatchObject({ ok: false, payload: { blocked: 'first_contact_needs_approval' } });

    const confirmed = await runWhatsAppSendGates({ ...base, confirmed: true }, accountRepo, conversationRepo, pool);
    expect(confirmed).toMatchObject({ ok: true });
  });

  it('keeps a group JID as the conversation id', async () => {
    const { accountRepo, conversationRepo, pool } = repos();
    const r = await runWhatsAppSendGates({ ...base, to: '123-456@g.us' }, accountRepo, conversationRepo, pool);
    expect(r).toMatchObject({ ok: true, conversationId: '123-456@g.us' });
  });
});
