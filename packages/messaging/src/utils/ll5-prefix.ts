/**
 * Deterministic [LL5] outbound-identity gate.
 *
 * Any message the agent sends to a CONTACT (a non-LL5 channel — WhatsApp/Telegram,
 * i.e. someone other than the user's own web/mobile chat) MUST begin with the `[LL5]`
 * prefix, so the recipient knows it's Arnon's AI assistant writing, not Arnon himself.
 *
 * This is enforced NON-AGENTICALLY at the send chokepoint (send_whatsapp / send_telegram):
 * a non-compliant send is REJECTED (not sent) and a correction is returned to the agent,
 * which must resend with the prefix. The agent is ALSO told the format in its persona, but
 * this gate does not trust that — it is the hard floor.
 *
 * (push_to_user / reply — the user's OWN unified thread — are not affected; this is only
 * for messages leaving to a third party.)
 */
export const LL5_PREFIX = '[LL5]';

// Leading whitespace tolerated; the prefix must be the first non-space token.
const LL5_PREFIX_RE = /^\s*\[LL5\]/;

export interface PrefixCheck {
  ok: boolean;
  /** A correction string to hand back to the agent when ok === false. */
  correction?: string;
}

/**
 * Validate that an outbound contact message carries the [LL5] prefix.
 * Returns { ok: true } when compliant, else { ok: false, correction }.
 */
export function checkLl5Prefix(message: string): PrefixCheck {
  if (LL5_PREFIX_RE.test(message)) return { ok: true };
  return {
    ok: false,
    correction:
      `REJECTED — NOT SENT. A message to a contact (a non-LL5 channel) MUST begin with the ` +
      `"${LL5_PREFIX}" prefix so the recipient knows it is Arnon's AI assistant writing, not Arnon ` +
      `himself. Resend the same message with the prefix at the very start, e.g. ` +
      `"${LL5_PREFIX} <your message>". This is a hard, deterministic gate — fix the prefix and call again.`,
  };
}
