import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

// DECISION-034 §5 rung 3 — reach text, self-JID, once-only.

vi.mock('../utils/timezone.js', () => ({ getEffectiveTimezone: async () => 'Asia/Jerusalem' }));
vi.mock('../utils/system-message.js', () => ({ insertSystemMessage: async () => 'id' }));
const sendFCMNotification = vi.fn(async () => undefined);
vi.mock('../utils/fcm-sender.js', () => ({ sendFCMNotification: (...a: unknown[]) => sendFCMNotification(...a) }));
const callMcpTool = vi.fn(async () => ({ sent: true }));
vi.mock('../utils/mcp-call.js', () => ({
  callMcpTool: (...a: unknown[]) => callMcpTool(...a),
  userBearer: () => 'Bearer test',
}));

import { buildReachText, reachAlreadySent, selfJidFromPhone, sendReachWhatsApp } from '../utils/reach.js';
import { sendRung } from '../delivery.js';
import { planRungs } from '../utils/delivery-contract.js';

describe('buildReachText', () => {
  it('opens with the messaging MCP prefix, then subject — first line (reach: unacknowledged, due HH:MM)', () => {
    expect(buildReachText('Card pickup', 'Card pickup, 17 HaNadiv — closes at 13:00.', '13:00'))
      .toBe('[LL5] LL5: Card pickup — Card pickup, 17 HaNadiv — closes at 13:00. (reach: unacknowledged, due 13:00)');
  });
  it('does not repeat the subject when the first line IS the subject, and omits due when unknown', () => {
    expect(buildReachText('Card pickup', 'Card pickup', null)).toBe('[LL5] LL5: Card pickup (reach: unacknowledged)');
    expect(buildReachText(null, 'Just the line', '09:05')).toBe('[LL5] LL5: Just the line (reach: unacknowledged, due 09:05)');
  });
});

describe('selfJidFromPhone', () => {
  it('turns the account phone into <digits>@s.whatsapp.net; keeps a JID; rejects short junk', () => {
    expect(selfJidFromPhone('+972 54-123-4567')).toBe('972541234567@s.whatsapp.net');
    expect(selfJidFromPhone('972541234567@s.whatsapp.net')).toBe('972541234567@s.whatsapp.net');
    expect(selfJidFromPhone('123')).toBeNull();
    expect(selfJidFromPhone(null)).toBeNull();
  });
});

describe('sendReachWhatsApp — resolution + gate outcomes', () => {
  beforeEach(() => { callMcpTool.mockClear(); });
  const cfg = { messagingMcpUrl: 'http://messaging.test', authSecret: 's' };

  function poolWith(account: { id: string; phone_number: string | null } | null, settings: { jid: string | null; account_id: string | null } | null) {
    const query = vi.fn(async (sql: string) => {
      if (/FROM messaging_whatsapp_accounts/.test(sql)) return { rows: account ? [account] : [], rowCount: account ? 1 : 0 };
      if (/FROM user_settings/.test(sql)) return { rows: settings ? [settings] : [], rowCount: settings ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    });
    return { query } as unknown as Pool;
  }

  it('uses the connected account phone as the self JID and passes confirmed:true', async () => {
    const r = await sendReachWhatsApp(poolWith({ id: 'acct-1', phone_number: '+972541234567' }, null), cfg, 'u1', '[LL5] LL5: x (reach: unacknowledged)');
    expect(r).toEqual({ ok: true, target: { account_id: 'acct-1', jid: '972541234567@s.whatsapp.net', source: 'account_phone' } });
    expect(callMcpTool).toHaveBeenCalledWith('http://messaging.test', 'Bearer test', 'send_whatsapp', {
      account_id: 'acct-1', to: '972541234567@s.whatsapp.net', message: '[LL5] LL5: x (reach: unacknowledged)', confirmed: true,
    });
  });

  it('falls back to user_settings.reach.whatsapp_jid when the account has no number', async () => {
    const r = await sendReachWhatsApp(poolWith({ id: 'acct-1', phone_number: null }, { jid: '972500000000', account_id: null }), cfg, 'u1', 'm');
    expect(r.target).toEqual({ account_id: 'acct-1', jid: '972500000000@s.whatsapp.net', source: 'user_settings' });
  });

  it('no JID anywhere → not sent, no MCP call', async () => {
    const r = await sendReachWhatsApp(poolWith(null, null), cfg, 'u1', 'm');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no self JID/);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('surfaces the messaging MCP gate (PERMISSION_DENIED / blocked) as a failure, never throws', async () => {
    callMcpTool.mockResolvedValueOnce({ error: 'PERMISSION_DENIED', priority: 'no-rule' } as never);
    const r1 = await sendReachWhatsApp(poolWith({ id: 'a', phone_number: '972541234567' }, null), cfg, 'u1', 'm');
    expect(r1).toMatchObject({ ok: false, error: 'PERMISSION_DENIED' });
    callMcpTool.mockRejectedValueOnce(new Error('mcp_timeout_8000ms') as never);
    const r2 = await sendReachWhatsApp(poolWith({ id: 'a', phone_number: '972541234567' }, null), cfg, 'u1', 'm');
    expect(r2).toMatchObject({ ok: false, error: 'mcp_timeout_8000ms' });
  });
});

describe('sendRung reach — once per delivery', () => {
  beforeEach(() => { callMcpTool.mockClear(); sendFCMNotification.mockClear(); });
  const NOW = new Date('2026-09-07T06:55:00Z');
  const SENT = new Date('2026-09-07T05:00:00Z');
  const DUE = new Date('2026-09-07T07:00:00Z');

  function row(escExtra: Record<string, unknown> = {}) {
    const rungs = planRungs('standard', SENT, DUE);
    return {
      id: 'd1', user_id: 'u1', message_id: 'm1', tray_item_id: 't1', class: 'do-by' as const, subject: 'Card pickup',
      stakes: 'medium' as const, due_at: DUE.toISOString(), modality: 'push_alarm' as const, delivery_mode: 'normal', ack_required: true,
      status: 'sent' as const, acknowledged_at: null, done_at: null,
      escalation: { spec: 'standard' as const, rungs, next_at: rungs[2].at, ladder_start: SENT.toISOString(), initial_push: 'sent' as const, ...escExtra },
      rung_sent: 2, created_at: SENT.toISOString(), content: 'Card pickup, 17 HaNadiv — closes at 10:00.',
    };
  }

  function poolWith(reachAlreadyClaimed: boolean) {
    const query = vi.fn(async (sql: string) => {
      if (/escalation->>'reach_sent_at' IS NULL/.test(sql)) return { rows: [], rowCount: reachAlreadyClaimed ? 0 : 1 };
      if (/FROM messaging_whatsapp_accounts/.test(sql)) return { rows: [{ id: 'acct-1', phone_number: '972541234567' }], rowCount: 1 };
      if (/UPDATE message_delivery/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE tray_items/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    return { pool: { query } as unknown as Pool, query };
  }

  it('sends the FCM reach rung AND the self-WhatsApp once, recording the result', async () => {
    const { pool, query } = poolWith(false);
    await sendRung(pool, row(), 2, 'Asia/Jerusalem', NOW, { messagingMcpUrl: 'http://messaging.test', authSecret: 's' });
    expect(sendFCMNotification).toHaveBeenCalledTimes(1);
    expect((sendFCMNotification.mock.calls[0] as unknown[])[2]).toMatchObject({ data: { rung: 'reach' } });
    expect(callMcpTool).toHaveBeenCalledTimes(1);
    const msg = (callMcpTool.mock.calls[0] as unknown[])[3] as { message: string; to: string };
    expect(msg.to).toBe('972541234567@s.whatsapp.net');
    expect(msg.message).toBe('[LL5] LL5: Card pickup — Card pickup, 17 HaNadiv — closes at 10:00. (reach: unacknowledged, due 10:00)');
    const recorded = query.mock.calls
      .flatMap((c) => ((c as unknown[])[1] as unknown[]) ?? [])
      .find((v) => typeof v === 'string' && v.includes('reach_result')) as string | undefined;
    expect(recorded).toBeDefined();
    expect(JSON.parse(recorded!).reach_result).toEqual({ ok: true, jid: '972541234567@s.whatsapp.net' });
  });

  it('a delivery whose reach was already claimed sends no second WhatsApp', async () => {
    const { pool } = poolWith(true);
    await sendRung(pool, row(), 2, 'Asia/Jerusalem', NOW, { messagingMcpUrl: 'http://messaging.test', authSecret: 's' });
    expect(callMcpTool).not.toHaveBeenCalled();
    expect(reachAlreadySent({ reach_sent_at: '2026-09-07T06:50:00Z' })).toBe(true);
    expect(reachAlreadySent({})).toBe(false);
  });

  it('a row already carrying reach_sent_at short-circuits before any claim', async () => {
    const { pool, query } = poolWith(false);
    await sendRung(pool, row({ reach_sent_at: '2026-09-07T06:50:00Z' }), 2, 'Asia/Jerusalem', NOW, { messagingMcpUrl: 'http://messaging.test', authSecret: 's' });
    expect(callMcpTool).not.toHaveBeenCalled();
    expect(query.mock.calls.some((c) => /reach_sent_at' IS NULL/.test(String((c as unknown[])[0])))).toBe(false);
  });

  it('without reach config the FCM rung still goes out and nothing else', async () => {
    const { pool } = poolWith(false);
    await sendRung(pool, row(), 2, 'Asia/Jerusalem', NOW);
    expect(sendFCMNotification).toHaveBeenCalledTimes(1);
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});
