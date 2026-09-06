import { describe, it, expect } from 'vitest';
import {
  GroupCoalescer,
  renderGroupBurst,
  GROUP_BURST_BODY_CAP,
  type CoalescedItem,
} from '../utils/group-coalescer.js';

// ISS-033: pure coalescer + renderer. Timers are injected and fired by hand —
// no fake timers, no mocks of anything external.

interface Meta { name: string }

function item(over: Partial<CoalescedItem> = {}): CoalescedItem {
  return { ts: 1_000, sender: 'Alice', text: 'hi', mediaInfo: '', quotedInfo: '', fromMe: false, ...over };
}

interface Flush { key: string; meta: Meta; items: CoalescedItem[] }

/** A coalescer whose timers are captured so a test can "elapse" a window on demand. */
function harness(opts: { windowMs?: number; maxItems?: number } = {}) {
  const flushes: Flush[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const c = new GroupCoalescer<Meta>({
    onFlush: (key, meta, items) => { flushes.push({ key, meta, items }); },
    windowMs: opts.windowMs ?? 90_000,
    maxItems: opts.maxItems ?? 12,
    setTimer: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  /** Fire every pending timer (the window elapsed). */
  const elapse = (): void => {
    for (const [id, fn] of Array.from(timers.entries())) { timers.delete(id); fn(); }
  };
  return { c, flushes, timers, elapse };
}

describe('GroupCoalescer', () => {
  it('a single item flushes as itself once the window elapses', () => {
    const { c, flushes, timers, elapse } = harness();
    c.push('u:g', { name: 'Fam' }, item({ text: 'only one' }));
    expect(flushes).toHaveLength(0);
    expect(timers.size).toBe(1);

    elapse();
    expect(flushes).toHaveLength(1);
    expect(flushes[0].key).toBe('u:g');
    expect(flushes[0].meta).toEqual({ name: 'Fam' });
    expect(flushes[0].items.map((i) => i.text)).toEqual(['only one']);
    expect(c.size('u:g')).toBe(0);
    expect(timers.size).toBe(0);
  });

  it('N items inside the window flush once, in order, with the latest meta', () => {
    const { c, flushes, timers, elapse } = harness();
    c.push('u:g', { name: 'v1' }, item({ ts: 1, text: 'a' }));
    c.push('u:g', { name: 'v2' }, item({ ts: 2, text: 'b' }));
    c.push('u:g', { name: 'v3' }, item({ ts: 3, text: 'c', fromMe: true, sender: '(me)' }));
    // One timer: the window is anchored on the FIRST item, later pushes do not re-arm it.
    expect(timers.size).toBe(1);
    expect(c.size('u:g')).toBe(3);

    elapse();
    expect(flushes).toHaveLength(1);
    expect(flushes[0].items.map((i) => i.text)).toEqual(['a', 'b', 'c']);
    expect(flushes[0].meta.name).toBe('v3');
  });

  it('maxItems flushes early and the next item opens a fresh window', () => {
    const { c, flushes, timers, elapse } = harness({ maxItems: 3 });
    expect(c.push('u:g', { name: 'g' }, item({ text: '1' }))).toBe(1);
    expect(c.push('u:g', { name: 'g' }, item({ text: '2' }))).toBe(2);
    expect(c.push('u:g', { name: 'g' }, item({ text: '3' }))).toBe(0); // hit the cap
    expect(flushes).toHaveLength(1);
    expect(flushes[0].items.map((i) => i.text)).toEqual(['1', '2', '3']);
    expect(timers.size).toBe(0); // the window's timer was cleared

    expect(c.push('u:g', { name: 'g' }, item({ text: '4' }))).toBe(1);
    expect(timers.size).toBe(1);
    elapse();
    expect(flushes).toHaveLength(2);
    expect(flushes[1].items.map((i) => i.text)).toEqual(['4']);
  });

  it('two conversations do not mix', () => {
    const { c, flushes, elapse } = harness();
    c.push('u:g1', { name: 'one' }, item({ text: 'g1-a' }));
    c.push('u:g2', { name: 'two' }, item({ text: 'g2-a' }));
    c.push('u:g1', { name: 'one' }, item({ text: 'g1-b' }));
    expect(c.openWindows).toBe(2);

    elapse();
    expect(flushes).toHaveLength(2);
    const byKey = Object.fromEntries(flushes.map((f) => [f.key, f.items.map((i) => i.text)]));
    expect(byKey).toEqual({ 'u:g1': ['g1-a', 'g1-b'], 'u:g2': ['g2-a'] });
  });

  it('flushAll drains every open window and awaits the handlers', async () => {
    const seen: string[] = [];
    const c = new GroupCoalescer<Meta>({
      onFlush: async (key) => { await Promise.resolve(); seen.push(key); },
      setTimer: () => 0,
      clearTimer: () => {},
    });
    c.push('u:a', { name: 'a' }, item());
    c.push('u:b', { name: 'b' }, item());
    await c.flushAll();
    expect(seen.sort()).toEqual(['u:a', 'u:b']);
    expect(c.openWindows).toBe(0);
    await c.flushAll(); // idempotent on empty
  });

  it('a failing flush handler is reported through onError, not thrown', async () => {
    const errors: string[] = [];
    const c = new GroupCoalescer<Meta>({
      onFlush: async () => { throw new Error('pg down'); },
      onError: (err, key, n) => { errors.push(`${key}:${n}:${(err as Error).message}`); },
      setTimer: () => 0,
      clearTimer: () => {},
    });
    c.push('u:g', { name: 'g' }, item());
    await expect(c.flush('u:g')).resolves.toBeUndefined();
    expect(errors).toEqual(['u:g:1:pg down']);
  });
});

describe('renderGroupBurst', () => {
  const naming = { groupName: 'Family', remoteJid: '1203@g.us' };

  it('renders a lone inbound item exactly as the per-message format (no header)', () => {
    const out = renderGroupBurst(naming, [
      item({ sender: 'Charlie', text: 'see you at 8', mediaInfo: ' [image attached]', quotedInfo: ' [replying to: «ok»]' }),
    ]);
    expect(out).toBe('[WhatsApp] Charlie (group: Family): "see you at 8" [image attached] [replying to: «ok»]');
  });

  it('renders a lone fromMe item exactly as the per-message outbound format', () => {
    const out = renderGroupBurst(naming, [item({ sender: '(me)', fromMe: true, text: 'on my way' })]);
    expect(out).toBe('[WhatsApp] You → group: Family: "on my way"');
  });

  it('falls back to the JID when the group has no name', () => {
    const out = renderGroupBurst({ groupName: null, remoteJid: '1203@g.us' }, [item({ sender: 'Bo', text: 'x' })]);
    expect(out).toBe('[WhatsApp] Bo: "x"');
    const outMe = renderGroupBurst({ groupName: null, remoteJid: '1203@g.us' }, [item({ fromMe: true, text: 'y' })]);
    expect(outMe).toBe('[WhatsApp] You → group: 1203@g.us: "y"');
  });

  it('renders a burst with a header, the span in seconds, and one line per item in order', () => {
    const out = renderGroupBurst(naming, [
      item({ ts: 10_000, sender: 'Alice', text: 'who is coming?' }),
      item({ ts: 25_000, sender: '(me)', fromMe: true, text: 'me' }),
      item({ ts: 55_400, sender: 'Bob', text: 'me too', mediaInfo: ' [image attached]' }),
    ]);
    expect(out).toBe([
      '[WhatsApp] group: Family — 3 messages over 45s:',
      '- Alice: "who is coming?"',
      '- You: "me"',
      '- Bob: "me too" [image attached]',
    ].join('\n'));
  });

  it('caps the body and reports how many lines were dropped', () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      item({ ts: i * 1000, sender: `S${i}`, text: 'x'.repeat(200) }));
    const out = renderGroupBurst(naming, items);
    expect(out.length).toBeLessThanOrEqual(GROUP_BURST_BODY_CAP + '\n… (+40 more)'.length);
    const m = out.match(/… \(\+(\d+) more\)$/);
    expect(m).not.toBeNull();
    const dropped = Number(m![1]);
    const included = out.split('\n').length - 2; // minus header and trailer
    expect(included + dropped).toBe(40);
    expect(included).toBeGreaterThan(10);
  });

  it('returns an empty string for no items', () => {
    expect(renderGroupBurst(naming, [])).toBe('');
  });
});
