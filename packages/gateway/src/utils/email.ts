import { logger } from './logger.js';

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
 * TODO(P1+): Real SMTP transport. Wire this once a provider (Postmark/SES/any
 * SMTP) and env config (SMTP_HOST/PORT/USER/PASS/FROM) are chosen. Do NOT add
 * a mail dependency until then; the shape below documents the intended seam.
 * `getEmailSender()` should return this when SMTP_HOST is set.
 *
 * Sketch:
 *   export class SmtpEmailSender implements EmailSender {
 *     constructor(private cfg: SmtpConfig) {}
 *     async send(msg: EmailMessage): Promise<void> {
 *       // connect via configured SMTP, send msg.{to,subject,text,html};
 *       // log to+subject on success, log error (never throw) on failure.
 *     }
 *   }
 */

let cached: EmailSender | undefined;

/**
 * Factory for the process-wide email sender. P1: always LogEmailSender.
 * When SMTP support lands, branch on env here and return SmtpEmailSender.
 */
export function getEmailSender(): EmailSender {
  if (!cached) {
    cached = new LogEmailSender();
  }
  return cached;
}
