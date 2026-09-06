/**
 * GroupCoalescer — buffers a burst of WhatsApp GROUP messages for one
 * conversation and hands them over as a single ordered batch (ISS-033).
 *
 * Why: when the user posts in a group, the escalation window makes that group
 * `immediate`, and every inbound message then became its own system message,
 * i.e. a full agent turn at 300K+ context. One active group produced 83 turns
 * in an hour ($72). Direct chats keep their per-message behaviour; only group
 * conversations go through here.
 *
 * Flush rules (per key = `${userId}:${remoteJid}`):
 *   (a) `windowMs` after the FIRST item of the window (not a sliding window —
 *       a chatty group cannot postpone delivery indefinitely);
 *   (b) immediately when the window holds `maxItems`;
 *   (c) `flushAll()` (shutdown / tests).
 * After a flush the next item opens a new window.
 *
 * Pure: no I/O. Timers are injectable so the module is testable without fake
 * timers; the default uses `setTimeout(...).unref()` so a pending window never
 * keeps the process alive. The flush handler may be async; a rejection is
 * reported through `onError` (never swallowed, never thrown into the caller).
 */

export interface CoalescedItem {
  /** Message timestamp, epoch ms. Used for the "over <m>s" span in rendering. */
  ts: number;
  /** Display name of the author; '(me)' for the user's own messages. */
  sender: string;
  /** Already truncated by the caller (200 inbound / 2000 fromMe). */
  text: string;
  /** Pre-rendered ` [image attached: …]` suffix, or ''. */
  mediaInfo: string;
  /** Pre-rendered ` [replying to: «…»]` suffix, or ''. */
  quotedInfo: string;
  fromMe: boolean;
}

export type FlushHandler<TMeta> = (
  key: string,
  meta: TMeta,
  items: CoalescedItem[],
) => void | Promise<void>;

export interface GroupCoalescerOptions<TMeta> {
  onFlush: FlushHandler<TMeta>;
  /** Window length measured from the first item. Default 90 s. */
  windowMs?: number;
  /** Flush early once a window holds this many items. Default 12. */
  maxItems?: number;
  /** Timer injection for tests. Defaults to unref'd setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called when `onFlush` throws or rejects. Default: console.error. */
  onError?: (err: unknown, key: string, itemCount: number) => void;
}

export const DEFAULT_GROUP_COALESCE_WINDOW_MS = 90_000;
export const DEFAULT_GROUP_COALESCE_MAX_ITEMS = 12;

interface Window<TMeta> {
  meta: TMeta;
  items: CoalescedItem[];
  timer: unknown;
}

export class GroupCoalescer<TMeta> {
  private readonly windows = new Map<string, Window<TMeta>>();
  private readonly onFlush: FlushHandler<TMeta>;
  private readonly windowMs: number;
  private readonly maxItems: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onError: (err: unknown, key: string, itemCount: number) => void;

  constructor(opts: GroupCoalescerOptions<TMeta>) {
    this.onFlush = opts.onFlush;
    this.windowMs = opts.windowMs ?? DEFAULT_GROUP_COALESCE_WINDOW_MS;
    this.maxItems = Math.max(1, opts.maxItems ?? DEFAULT_GROUP_COALESCE_MAX_ITEMS);
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.onError = opts.onError ?? ((err, key, n) => {
      console.error('[GroupCoalescer] flush handler failed', { key, items: n, error: err instanceof Error ? err.message : String(err) });
    });
  }

  /**
   * Add an item to the conversation's window, opening one if needed. `meta` is
   * refreshed on every push so the flush sees the most recent group metadata.
   * Returns the number of items now buffered for the key (0 if this push
   * triggered a maxItems flush).
   */
  push(key: string, meta: TMeta, item: CoalescedItem): number {
    let win = this.windows.get(key);
    if (!win) {
      win = { meta, items: [], timer: null };
      win.timer = this.setTimer(() => this.flush(key), this.windowMs);
      this.windows.set(key, win);
    }
    win.meta = meta;
    win.items.push(item);
    if (win.items.length >= this.maxItems) {
      this.flush(key);
      return 0;
    }
    return win.items.length;
  }

  /** Deliver the window for `key` now (no-op if none). Returns the handler's promise. */
  flush(key: string): Promise<void> {
    const win = this.windows.get(key);
    if (!win) return Promise.resolve();
    this.windows.delete(key);
    if (win.timer !== null) this.clearTimer(win.timer);
    const items = win.items;
    let result: Promise<void>;
    try {
      result = Promise.resolve(this.onFlush(key, win.meta, items));
    } catch (err) {
      result = Promise.reject(err);
    }
    return result.catch((err) => this.onError(err, key, items.length));
  }

  /** Deliver every open window (shutdown). Resolves when all handlers settle. */
  flushAll(): Promise<void> {
    const keys = Array.from(this.windows.keys());
    return Promise.all(keys.map((k) => this.flush(k))).then(() => undefined);
  }

  /** Items currently buffered for `key` (0 when no window is open). */
  size(key: string): number {
    return this.windows.get(key)?.items.length ?? 0;
  }

  /** Number of open windows across all conversations. */
  get openWindows(): number {
    return this.windows.size;
  }
}

// ---------------------------------------------------------------------------
// Rendering — the system-message body the agent reads.
// ---------------------------------------------------------------------------

export const GROUP_BURST_BODY_CAP = 4000;

export interface GroupBurstNaming {
  /** Resolved group name (conversation name, else the JID). */
  groupName: string | null;
  remoteJid: string;
}

/**
 * Render one burst as the agent-facing message.
 *
 * A single-item burst renders EXACTLY as the pre-coalescing per-message format
 * (no header), so a lone group message reads the same as before:
 *   inbound: `[WhatsApp] <sender> (group: <name>): "<text>"<media><quoted>`
 *   fromMe:  `[WhatsApp] You → group: <name>: "<text>"<media><quoted>`
 *
 * Multi-item:
 *   `[WhatsApp] group: <name> — <n> messages over <m>s:`
 *   `- <sender|You>: "<text>"<media><quoted>` per item, in order,
 * with the whole body capped at GROUP_BURST_BODY_CAP chars and a trailing
 * `… (+k more)` when lines were dropped.
 */
export function renderGroupBurst(naming: GroupBurstNaming, items: CoalescedItem[]): string {
  if (items.length === 0) return '';
  const displayName = naming.groupName ?? naming.remoteJid;

  if (items.length === 1) {
    const it = items[0];
    if (it.fromMe) {
      return `[WhatsApp] You → group: ${displayName}: "${it.text}"${it.mediaInfo}${it.quotedInfo}`;
    }
    const header = `${it.sender}${naming.groupName ? ` (group: ${naming.groupName})` : ''}`;
    return `[WhatsApp] ${header}: "${it.text}"${it.mediaInfo}${it.quotedInfo}`;
  }

  const first = items[0].ts;
  const last = items[items.length - 1].ts;
  const spanSec = Math.max(0, Math.round((last - first) / 1000));
  const head = `[WhatsApp] group: ${displayName} — ${items.length} messages over ${spanSec}s:`;

  const lines = items.map((it) =>
    `- ${it.fromMe ? 'You' : it.sender}: "${it.text}"${it.mediaInfo}${it.quotedInfo}`);

  let body = head;
  let included = 0;
  for (const line of lines) {
    // Always include the first line; afterwards stop once the cap would be crossed.
    if (included > 0 && body.length + 1 + line.length > GROUP_BURST_BODY_CAP) break;
    body += `\n${line}`;
    included += 1;
  }
  const dropped = lines.length - included;
  if (dropped > 0) body += `\n… (+${dropped} more)`;
  return body;
}
