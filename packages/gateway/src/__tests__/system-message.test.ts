import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

// Mock agent-trigger BEFORE importing system-message (vi.mock is hoisted).
const triggerAgentMock = vi.fn().mockResolvedValue(undefined);
const getAgentSessionIdMock = vi.fn().mockResolvedValue('sess-abc-123');
vi.mock('../utils/agent-trigger.js', () => ({
  triggerAgent: (...a: unknown[]) => triggerAgentMock(...a),
  getAgentSessionId: (...a: unknown[]) => getAgentSessionIdMock(...a),
  resolveAgentBaseUrl: () => Promise.resolve(null),
}));

// Mock FCM + scheduler-health so the real insertSystemMessage can run without
// network calls or cross-module state.
vi.mock('../utils/fcm-sender.js', () => ({
  sendFCMNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/scheduler-health.js', () => ({
  recordTickOk: vi.fn(),
  recordTickError: vi.fn(),
}));

import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

const USER_ID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';

function poolWith(insertId: string | null): Pool {
  const query = vi.fn(async () => ({
    rows: insertId ? [{ id: insertId }] : [],
    rowCount: insertId ? 1 : 0,
  }));
  return { query } as unknown as Pool;
}

describe('insertSystemMessage — agent trigger integration (Phase 2)', () => {
  beforeEach(() => {
    triggerAgentMock.mockClear();
    getAgentSessionIdMock.mockClear();
    getAgentSessionIdMock.mockResolvedValue('sess-abc-123');
  });

  afterEach(() => {
    delete process.env.OPENCODE_SERVER_URL;
  });

  it('does NOT call triggerAgent when OPENCODE_SERVER_URL is unset (Claude Code variant)', async () => {
    delete process.env.OPENCODE_SERVER_URL;
    await insertSystemMessage(poolWith('msg-1'), USER_ID, 'test content');
    expect(triggerAgentMock).not.toHaveBeenCalled();
  });

  it('calls triggerAgent with full content and metadata when OPENCODE_SERVER_URL is set', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const evt = createSchedulerEvent('evening-close');
    const source = { platform: 'whatsapp', remote_jid: '123@s.whatsapp.net', from_me: false };

    await insertSystemMessage(poolWith('msg-2'), USER_ID, '[Evening Close] Run skill', undefined, evt, source);

    // Fire-and-forget — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(getAgentSessionIdMock).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(triggerAgentMock).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = triggerAgentMock.mock.calls[0];
    expect(sessionId).toBe('sess-abc-123');
    expect(payload.content).toContain('[Evening Close] Run skill');
    expect(payload.content).toContain(`[event_id: ${evt.event_id}]`);
    expect(payload.metadata).toEqual({ source, scheduler: evt });
  });

  it('does NOT call triggerAgent when the PG insert fails (no messageId)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const pool = {
      query: vi.fn(async () => { throw new Error('DB connection lost'); }),
    } as unknown as Pool;

    await insertSystemMessage(pool, USER_ID, 'test content');
    await new Promise((r) => setTimeout(r, 0));

    expect(triggerAgentMock).not.toHaveBeenCalled();
  });

  it('does NOT call triggerAgent when no agent session is registered', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    getAgentSessionIdMock.mockResolvedValue(null);

    await insertSystemMessage(poolWith('msg-3'), USER_ID, 'test content');
    await new Promise((r) => setTimeout(r, 0));

    expect(triggerAgentMock).not.toHaveBeenCalled();
  });

  it('triggerAgent failure does NOT crash insertSystemMessage (fire-and-forget)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    triggerAgentMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // Should resolve normally — the trigger is fire-and-forget
    const result = await insertSystemMessage(poolWith('msg-4'), USER_ID, 'test content');
    expect(result).toBe('msg-4');
    await new Promise((r) => setTimeout(r, 0));
    expect(triggerAgentMock).toHaveBeenCalledTimes(1);
  });

  it('passes noReply flag through to triggerAgent when set', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    await insertSystemMessage(poolWith('msg-5'), USER_ID, 'silent ping');
    await new Promise((r) => setTimeout(r, 0));
    // noReply is not currently set by insertSystemMessage (it's for future
    // use by schedulers that want a silent ack). Verify the default (unset).
    expect(triggerAgentMock.mock.calls[0][1].noReply).toBeUndefined();
  });
});
