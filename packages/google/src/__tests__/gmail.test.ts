import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import type { GoogleClientConfig } from '../utils/google-client.js';
import { captureTools, parseToolResponse } from './_helpers.js';

const { loggerError, loggerWarn, loggerInfo } = vi.hoisted(() => ({
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError, debug: vi.fn() },
}));

vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
  generateToken: vi.fn().mockReturnValue('mock-gw-token'),
  sessionTimezone: vi.fn().mockReturnValue('Asia/Jerusalem'),
}));

const { mockMessagesGet, mockMessagesSend } = vi.hoisted(() => ({
  mockMessagesGet: vi.fn(),
  mockMessagesSend: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    gmail: () => ({
      users: {
        messages: { get: mockMessagesGet, send: mockMessagesSend },
      },
    }),
  },
}));

vi.mock('../utils/google-client.js', () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({ setCredentials: vi.fn() }),
}));

const USER_ID = 'gmail-user-1';
const getUserId = () => USER_ID;
const GOOGLE_CONFIG: GoogleClientConfig = {
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'https://example.com/cb',
};

function makeTokenRepo(): OAuthTokenRepository {
  return {
    store: vi.fn(),
    get: vi.fn(),
    updateAccessToken: vi.fn(),
    updateRefreshToken: vi.fn(),
    delete: vi.fn(),
  } as unknown as OAuthTokenRepository;
}

async function getSendEmail() {
  const { registerGmailTools } = await import('../tools/gmail.js');
  const tools = captureTools((s) => registerGmailTools(s, makeTokenRepo(), GOOGLE_CONFIG, getUserId));
  return tools.get('send_email')!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('send_email reply path — fetch failure must not silently send a standalone email', () => {
  it('returns isError and does NOT send when the original message fetch fails on an explicit reply', async () => {
    mockMessagesGet.mockRejectedValue(new Error('404 not found'));

    const sendEmail = await getSendEmail();
    const res = await sendEmail({
      to: ['a@example.com'],
      subject: 'Re: hi',
      body: 'reply body',
      reply_to_message_id: 'orig-msg-99',
    });

    expect(res.isError).toBe(true);
    // critically: no email was sent as a standalone message
    expect(mockMessagesSend).not.toHaveBeenCalled();
    // failure is logged clearly
    expect(loggerError).toHaveBeenCalled();
  });

  it('sends normally with threading headers when the fetch succeeds', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        threadId: 'thread-1',
        payload: { headers: [{ name: 'Message-ID', value: '<orig@x>' }] },
      },
    });
    mockMessagesSend.mockResolvedValue({ data: { id: 'sent-1', threadId: 'thread-1' } });

    const sendEmail = await getSendEmail();
    const res = await sendEmail({
      to: ['a@example.com'],
      subject: 'Re: hi',
      body: 'reply body',
      reply_to_message_id: 'orig-msg-99',
    });

    expect(res.isError).toBeFalsy();
    expect(mockMessagesSend).toHaveBeenCalledTimes(1);
    const sentReq = mockMessagesSend.mock.calls[0][0] as { requestBody: { threadId?: string } };
    expect(sentReq.requestBody.threadId).toBe('thread-1');
    const parsed = parseToolResponse<{ thread_id: string }>(res);
    expect(parsed.thread_id).toBe('thread-1');
  });

  it('sends a normal (non-reply) email without fetching anything', async () => {
    mockMessagesSend.mockResolvedValue({ data: { id: 'sent-2', threadId: 'thread-2' } });

    const sendEmail = await getSendEmail();
    const res = await sendEmail({
      to: ['a@example.com'],
      subject: 'hello',
      body: 'body',
    });

    expect(res.isError).toBeFalsy();
    expect(mockMessagesGet).not.toHaveBeenCalled();
    expect(mockMessagesSend).toHaveBeenCalledTimes(1);
  });
});
