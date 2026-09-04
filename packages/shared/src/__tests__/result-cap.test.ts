import { describe, it, expect } from 'vitest';
import {
  MCP_RESULT_CAP_CHARS,
  MCP_RESULT_CAP_HARD_MAX,
  MCP_RESULT_CAP_MIN,
  encodeCursor,
  decodeCursor,
  resolveOffset,
  resolveCap,
  capItems,
  pageFields,
  clipText,
} from '../mcp/result-cap.js';

function item(i: number, size = 1000) {
  return { id: `it-${i}`, body: 'x'.repeat(size) };
}

describe('result-cap (ISS-019)', () => {
  it('cursor round-trips an offset and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(37))).toBe(37);
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor('')).toBe(0);
    expect(() => decodeCursor('not-a-cursor')).toThrow(/Invalid cursor/);
    expect(() => decodeCursor(Buffer.from('o:-4').toString('base64url'))).toThrow(/Invalid cursor/);
    expect(() => encodeCursor(-1)).toThrow();
  });

  it('resolveOffset: cursor wins over legacy offset; bad values → 0', () => {
    expect(resolveOffset({})).toBe(0);
    expect(resolveOffset({ offset: 12 })).toBe(12);
    expect(resolveOffset({ offset: 12, cursor: encodeCursor(40) })).toBe(40);
    expect(resolveOffset({ offset: -3 })).toBe(0);
  });

  it('resolveCap clamps into [MIN, HARD_MAX] and defaults to the 20 KB cap', () => {
    expect(resolveCap()).toBe(MCP_RESULT_CAP_CHARS);
    expect(resolveCap(undefined)).toBe(20_000);
    expect(resolveCap(10)).toBe(MCP_RESULT_CAP_MIN);
    expect(resolveCap(10_000_000)).toBe(MCP_RESULT_CAP_HARD_MAX);
    expect(resolveCap(50_000)).toBe(50_000);
  });

  it('keeps a prefix that fits under the cap at item boundaries, never mid-item', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(i, 1000));
    const r = capItems(items, { offset: 0 });
    // Each item is ~1,020 chars; budget is 20,000 - 400 → 19 items fit, 20 do not.
    expect(r.items.length).toBeGreaterThan(10);
    expect(r.items.length).toBeLessThan(50);
    expect(JSON.stringify(r.items).length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS - 400);
    // Adding one more item would overflow the budget.
    expect(JSON.stringify(items.slice(0, r.items.length + 1)).length).toBeGreaterThan(MCP_RESULT_CAP_CHARS - 400);
    // Every kept item is intact.
    for (const it of r.items) expect(it.body.length).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.dropped).toBe(50 - r.items.length);
    expect(decodeCursor(r.next_cursor)).toBe(r.items.length);
    expect(r.hint).toMatch(/cursor/);
  });

  it('next_cursor continues exactly where the previous page stopped (page 2 = remaining items)', () => {
    const all = Array.from({ length: 40 }, (_, i) => item(i, 1000));
    const p1 = capItems(all, { offset: 0 });
    const off = decodeCursor(p1.next_cursor);
    const p2 = capItems(all.slice(off), { offset: off });
    const seen = [...p1.items, ...p2.items].map((x) => x.id);
    // No overlap, no gap between the pages.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 5)).toEqual(['it-0', 'it-1', 'it-2', 'it-3', 'it-4']);
    expect(seen[p1.items.length]).toBe(`it-${p1.items.length}`);
    if (p2.truncated) {
      expect(decodeCursor(p2.next_cursor)).toBe(off + p2.items.length);
    } else {
      expect(seen.length).toBe(40);
    }
  });

  it('small results are untouched and carry no page fields', () => {
    const items = [item(0, 50), item(1, 50)];
    const r = capItems(items, { offset: 0 });
    expect(r.items).toBe(items === r.items ? items : r.items); // same content
    expect(r.items).toEqual(items);
    expect(r.truncated).toBe(false);
    expect(r.next_cursor).toBeUndefined();
    expect(pageFields(r)).toEqual({});
  });

  it('hasMore from the source marks truncated even when the page fits', () => {
    const items = [item(0, 50), item(1, 50)];
    const r = capItems(items, { offset: 10, hasMore: true, hint: 'Use `since`.' });
    expect(r.items).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(decodeCursor(r.next_cursor)).toBe(12);
    expect(r.hint).toContain('Use `since`.');
    expect(pageFields(r)).toEqual({ truncated: true, next_cursor: r.next_cursor, hint: r.hint });
  });

  it('always keeps at least one item, even when it alone exceeds the cap', () => {
    const r = capItems([item(0, 30_000), item(1, 10)], { offset: 0 });
    expect(r.items.map((x) => x.id)).toEqual(['it-0']);
    expect(r.truncated).toBe(true);
  });

  it('honours a custom cap and a custom measure', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i, 100));
    const compact = capItems(items, { offset: 0, cap: 1_000, reserve: 0 });
    // ~120 chars each → 8 fit compactly.
    expect(compact.items.length).toBe(8);
    const pretty = capItems(items, { offset: 0, cap: 1_000, reserve: 0, measure: (x) => JSON.stringify(x, null, 2).length });
    expect(pretty.items.length).toBeLessThan(compact.items.length);
  });

  it('clipText clips long strings only', () => {
    expect(clipText('short', 10)).toBe('short');
    expect(clipText('x'.repeat(20), 5)).toBe('xxxxx… [+15 chars]');
    expect(clipText(42, 5)).toBe(42);
  });
});
