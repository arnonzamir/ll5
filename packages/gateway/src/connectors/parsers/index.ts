/**
 * Parser dispatch: connector id → issuer parser, everything else (bank,
 * paybox, water, iec, any future catalog id) → the generic parser, which
 * always yields an event for non-empty text (kind 'unknown' unless a pattern
 * matches). `parse` is pure (no I/O, no clock beyond input.post_time) and
 * returns null only when the notification carries no text at all.
 */
import type { ConnectorEventInput } from '@ll5/shared';
import type { ParserInput } from './types.js';
import { parseCal } from './cal.js';
import { parseMax } from './max.js';
import { parseIsracard } from './isracard.js';
import { parseClalit } from './clalit.js';
import { parseSmsGeneric } from './sms-generic.js';

export type { ParserInput, ParserName } from './types.js';
export { dedupeKey, normalizeText, extractAmount, extractCardLast4, extractOccurredAt, classifyKind, redactCodes, zonedIso } from './common.js';

const PARSERS: Record<string, (input: ParserInput) => ConnectorEventInput | null> = {
  cal: parseCal,
  max: parseMax,
  isracard: parseIsracard,
  clalit: parseClalit,
};

export function parse(input: ParserInput): ConnectorEventInput | null {
  const fn = PARSERS[input.connector_id] ?? parseSmsGeneric;
  return fn(input);
}
