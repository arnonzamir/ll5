import nodemailer from 'nodemailer';
import { logger } from './logger.js';
import { loadSmtpConfig, type SmtpConfig } from './env.js';

/**
 * A single outbound email message.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Pluggable email transport. Implementations MUST NOT throw on a failed send —
 * callers (invite/reset flows) treat email as best-effort and must never leak
 * a 500 to the client over a transport hiccup (and never enumerate users via a
 * send error). Surface failures by logging, not by throwing.
 */
export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

/**
 * Default / dev-fallback sender: writes the email to the structured logger so
 * the link is recoverable from logs when no SMTP is configured. Deliberately
 * logs `to` + `subject` but the full body (which may carry a raw token link)
 * only at debug level — callers must NOT log the raw token themselves.
 */
export class LogEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<void> {
    try {
      logger.info('[email][LogEmailSender] Email (no SMTP configured — logging instead of sending)', {
        to: msg.to,
        subject: msg.subject,
      });
      // The body can carry a raw token link; keep it at debug so it is not in
      // default-level logs but is recoverable for dev/onboarding.
      logger.debug('[email][LogEmailSender] Email body', {
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
      });
    } catch (err) {
      // Never throw — email is best-effort in P1.
      logger.error('[email][LogEmailSender] Failed to log email', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Minimal transport seam — the subset of a nodemailer transport this sender
 * uses. Injectable so tests can pass a fake transport instead of opening a real
 * SMTP connection.
 */
export interface MailTransport {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

/**
 * Build a real nodemailer transport from SMTP config. Auth is included only
 * when both user and pass are present (some relays use IP allow-listing).
 */
function createNodemailerTransport(cfg: SmtpConfig): MailTransport {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

/**
 * Real SMTP sender. Provider-agnostic — works with Brevo/Resend/SES/any SMTP.
 *
 * Unlike LogEmailSender, this DOES rethrow on a transport failure: the
 * invite/reset callers already wrap send() in a best-effort try/catch, so a
 * thrown error is logged-and-swallowed there (the user still gets a generic
 * response) while remaining observable here. We never log secrets or the raw
 * token body — only `to` + `subject`.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: MailTransport;
  private readonly from: string;

  /**
   * @param cfg       SMTP config. `from` MUST be set (the factory guarantees it).
   * @param transport Injectable transport — defaults to a real nodemailer
   *                  transport built from `cfg`. Tests pass a fake.
   */
  constructor(cfg: SmtpConfig, transport?: MailTransport) {
    if (!cfg.from) {
      throw new Error('SmtpEmailSender requires SMTP_FROM to be configured');
    }
    this.from = cfg.from;
    this.transport = transport ?? createNodemailerTransport(cfg);
  }

  async send(msg: EmailMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      });
      logger.info('[email][SmtpEmailSender] Email sent', {
        to: msg.to,
        subject: msg.subject,
      });
    } catch (err) {
      // Log without secrets or body, then rethrow — callers are best-effort.
      logger.error('[email][SmtpEmailSender] Failed to send email', {
        to: msg.to,
        subject: msg.subject,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

let cached: EmailSender | undefined;
let loggedNoSmtp = false;

/**
 * Resolve the appropriate sender from SMTP config (pure — no caching, no env
 * read). Returns SmtpEmailSender when both host and from are set, else the
 * log-only fallback. Exposed for testing the selection logic without touching
 * process.env or the module cache.
 */
export function createEmailSender(cfg: SmtpConfig): EmailSender {
  if (cfg.host && cfg.from) {
    return new SmtpEmailSender(cfg);
  }
  if (!loggedNoSmtp) {
    logger.info(
      '[email] SMTP not configured (SMTP_HOST/SMTP_FROM unset) — invite/reset links will only be logged, not emailed',
    );
    loggedNoSmtp = true;
  }
  return new LogEmailSender();
}

/**
 * Factory for the process-wide email sender. Returns a cached SmtpEmailSender
 * when SMTP is configured, else a cached LogEmailSender. Reads config from env.
 */
export function getEmailSender(): EmailSender {
  if (!cached) {
    cached = createEmailSender(loadSmtpConfig());
  }
  return cached;
}

/** Test-only: reset the module-level cache and the one-time log flag. */
export function resetEmailSenderForTests(): void {
  cached = undefined;
  loggedNoSmtp = false;
}
