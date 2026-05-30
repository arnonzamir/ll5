import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SmtpEmailSender,
  LogEmailSender,
  createEmailSender,
  getEmailSender,
  resetEmailSenderForTests,
  type MailTransport,
} from '../utils/email.js';
import type { SmtpConfig } from '../utils/env.js';

/** A fully-configured SMTP config (host + from present → SMTP path). */
function smtpConfig(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: 'smtp.example.com',
    port: 587,
    user: 'apikey',
    pass: 'secret-do-not-log',
    secure: false,
    from: 'LL5 <no-reply@example.com>',
    ...overrides,
  };
}

/** A fake transport that records sendMail calls and can be made to fail. */
function fakeTransport(opts: { fail?: Error } = {}): MailTransport & {
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async sendMail(mailOpts) {
      calls.push(mailOpts as Record<string, unknown>);
      if (opts.fail) {
        throw opts.fail;
      }
      return { messageId: 'fake-id' };
    },
  };
}

describe('SmtpEmailSender', () => {
  it('calls sendMail with the right from/to/subject/text/html', async () => {
    const transport = fakeTransport();
    const sender = new SmtpEmailSender(smtpConfig(), transport);

    await sender.send({
      to: 'user@dest.com',
      subject: 'Your invite',
      text: 'plain link',
      html: '<a>link</a>',
    });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toEqual({
      from: 'LL5 <no-reply@example.com>',
      to: 'user@dest.com',
      subject: 'Your invite',
      text: 'plain link',
      html: '<a>link</a>',
    });
  });

  it('omits html when not provided', async () => {
    const transport = fakeTransport();
    const sender = new SmtpEmailSender(smtpConfig(), transport);

    await sender.send({ to: 'a@b.com', subject: 'S', text: 'T' });

    expect(transport.calls[0]).not.toHaveProperty('html');
    expect(transport.calls[0]).toMatchObject({ to: 'a@b.com', subject: 'S', text: 'T' });
  });

  it('rethrows when the transport fails', async () => {
    const boom = new Error('SMTP 535 auth failed');
    const transport = fakeTransport({ fail: boom });
    const sender = new SmtpEmailSender(smtpConfig(), transport);

    await expect(
      sender.send({ to: 'a@b.com', subject: 'S', text: 'T' }),
    ).rejects.toThrow('SMTP 535 auth failed');
  });

  it('throws at construction when SMTP_FROM is missing', () => {
    expect(() => new SmtpEmailSender(smtpConfig({ from: undefined }), fakeTransport())).toThrow(
      /SMTP_FROM/,
    );
  });
});

describe('createEmailSender (factory selection)', () => {
  it('returns SmtpEmailSender when host and from are set', () => {
    const sender = createEmailSender(smtpConfig());
    expect(sender).toBeInstanceOf(SmtpEmailSender);
  });

  it('returns LogEmailSender when host is missing', () => {
    const sender = createEmailSender(smtpConfig({ host: undefined }));
    expect(sender).toBeInstanceOf(LogEmailSender);
  });

  it('returns LogEmailSender when from is missing', () => {
    const sender = createEmailSender(smtpConfig({ from: undefined }));
    expect(sender).toBeInstanceOf(LogEmailSender);
  });
});

describe('getEmailSender (env-driven + cached)', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    resetEmailSenderForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    resetEmailSenderForTests();
    vi.restoreAllMocks();
  });

  it('returns LogEmailSender when SMTP env is unset', () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    expect(getEmailSender()).toBeInstanceOf(LogEmailSender);
  });

  it('returns SmtpEmailSender when SMTP_HOST and SMTP_FROM are set', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'LL5 <no-reply@example.com>';
    expect(getEmailSender()).toBeInstanceOf(SmtpEmailSender);
  });

  it('caches the instance across calls', () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    const first = getEmailSender();
    const second = getEmailSender();
    expect(second).toBe(first);
  });
});
