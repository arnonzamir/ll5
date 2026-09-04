/**
 * MCP read-result cap + cursor pagination (ISS-019).
 *
 * Every MCP read tool that can return a list must bound its payload: the agent's
 * context cannot absorb a 60 KB journal page or a 1.7 MB session sweep, and the
 * Claude Code harness then spills the result to a local file that the agent greps
 * instead of narrowing its query (ISS-018) — bypassing Elasticsearch, producing no
 * audit row and no grounding credit.
 *
 * Contract (identical across awareness / personal-knowledge / messaging tools):
 *   - `MCP_RESULT_CAP_CHARS` (~20 KB of serialized JSON) is the default ceiling.
 *   - Truncation happens at ITEM boundaries — never mid-item. Items are assumed to
 *     be in the order the tool wants them shown (most recent first for time-ordered
 *     tools); the cap keeps a prefix.
 *   - Tools accept an opaque `cursor` (encodes the absolute offset of the next item)
 *     and return `truncated: true` + `next_cursor` + a short `hint` when more exists.
 *     Small results carry NONE of those fields, so they are byte-identical to the
 *     pre-cap envelope.
 *   - Programmatic consumers (gateway/dashboard) may pass `max_chars` on the tools
 *     that expose it; `resolveCap` clamps it to `MCP_RESULT_CAP_HARD_MAX`.
 */

/** Default cap on a serialized MCP read result, in characters (~20 KB). ISS-019. */
export const MCP_RESULT_CAP_CHARS = 20_000;

/** Absolute ceiling for a caller-supplied `max_chars` override. */
export const MCP_RESULT_CAP_HARD_MAX = 500_000;

/** Smallest cap a caller may request — below this nothing useful fits. */
export const MCP_RESULT_CAP_MIN = 1_000;

const CURSOR_PREFIX = 'o:';

/** Encode an absolute item offset as an opaque cursor string. */
export function encodeCursor(offset: number): string {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`encodeCursor: offset must be a non-negative integer, got ${String(offset)}`);
  }
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor produced by `encodeCursor`. `undefined` / `null` / '' → 0.
 * Throws an Error with a caller-facing message on garbage so the tool can return
 * a structured error instead of silently restarting from the top.
 */
export function decodeCursor(cursor: string | null | undefined): number {
  if (cursor == null || cursor === '') return 0;
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid cursor: not decodable');
  }
  if (!raw.startsWith(CURSOR_PREFIX)) throw new Error('Invalid cursor: unrecognized format');
  const n = Number(raw.slice(CURSOR_PREFIX.length));
  if (!Number.isInteger(n) || n < 0) throw new Error('Invalid cursor: bad offset');
  return n;
}

/**
 * Resolve the starting offset for a paged read. `cursor` wins over a legacy
 * numeric `offset` param when both are present.
 */
export function resolveOffset(params: { cursor?: string | null; offset?: number | null }): number {
  if (params.cursor) return decodeCursor(params.cursor);
  const o = params.offset ?? 0;
  return Number.isInteger(o) && o > 0 ? o : 0;
}

/** Clamp a caller-supplied `max_chars` into [MIN, HARD_MAX]; undefined → default cap. */
export function resolveCap(maxChars?: number | null): number {
  if (maxChars == null || !Number.isFinite(maxChars)) return MCP_RESULT_CAP_CHARS;
  return Math.min(MCP_RESULT_CAP_HARD_MAX, Math.max(MCP_RESULT_CAP_MIN, Math.floor(maxChars)));
}

export interface CapOptions<T> {
  /** Absolute offset of `items[0]` in the full result set (for `next_cursor`). */
  offset: number;
  /** True when the SOURCE holds more items beyond `items` (e.g. total > offset + items.length). */
  hasMore?: boolean;
  /** Character budget for the items array. Default `MCP_RESULT_CAP_CHARS`. */
  cap?: number;
  /** Characters reserved for the rest of the envelope (other fields, page fields). Default 400. */
  reserve?: number;
  /** Tool-specific advice on how to narrow the query. Appended to the generic hint. */
  hint?: string;
  /** Size measure per item. Default `JSON.stringify(item).length` (compact JSON). */
  measure?: (item: T) => number;
}

export interface CapResult<T> {
  items: T[];
  truncated: boolean;
  /** Present only when `truncated`. */
  next_cursor?: string;
  /** Present only when `truncated`. */
  hint?: string;
  /** Items dropped from THIS page by the cap (not counting `hasMore` beyond the page). */
  dropped: number;
}

/**
 * Keep the longest prefix of `items` whose serialized size fits the cap, at item
 * boundaries. Always keeps at least one item (a single oversized item is the tool's
 * job to pre-clip — see `clipText`). Marks `truncated` when items were dropped OR
 * the source reported more beyond this page.
 */
export function capItems<T>(items: T[], opts: CapOptions<T>): CapResult<T> {
  const cap = opts.cap ?? MCP_RESULT_CAP_CHARS;
  const reserve = opts.reserve ?? 400;
  const measure = opts.measure ?? ((item: T) => JSON.stringify(item).length);
  const budget = Math.max(0, cap - reserve);

  const kept: T[] = [];
  let used = 2; // the array brackets
  for (const item of items) {
    const size = measure(item) + 1; // + separator
    if (kept.length > 0 && used + size > budget) break;
    kept.push(item);
    used += size;
  }

  const dropped = items.length - kept.length;
  const truncated = dropped > 0 || opts.hasMore === true;
  if (!truncated) return { items: kept, truncated: false, dropped: 0 };

  const nextOffset = opts.offset + kept.length;
  const hint =
    `Result capped at ~${Math.round(cap / 1000)} KB (${kept.length} of ${items.length}${opts.hasMore ? '+' : ''} items shown). ` +
    (opts.hint ? `${opts.hint} ` : '') +
    'Narrow the query, lower `limit`, or pass `cursor: next_cursor` to continue.';
  return { items: kept, truncated: true, next_cursor: encodeCursor(nextOffset), hint, dropped };
}

/**
 * The envelope fields for a paged result: `{}` when nothing was truncated (so small
 * results stay byte-identical), else `{ truncated: true, next_cursor, hint }`.
 */
export function pageFields<T>(r: CapResult<T>): { truncated: true; next_cursor: string; hint: string } | Record<string, never> {
  if (!r.truncated) return {};
  return { truncated: true, next_cursor: r.next_cursor as string, hint: r.hint as string };
}

/** Clip a string to `max` chars with an ellipsis marker. Non-strings pass through. */
export function clipText<T>(value: T, max: number): T | string {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max)}… [+${value.length - max} chars]`;
}
