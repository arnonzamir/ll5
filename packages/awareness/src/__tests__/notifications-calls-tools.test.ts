import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { decodeCursor, encodeCursor, MCP_RESULT_CAP_CHARS } from '@ll5/shared';
import { registerNotificationTools, queryNotificationsSchema, NOTIFICATION_LIMIT_MAX } from '../tools/notifications.js';
import { registerCallTools, queryCallsSchema, CALL_LIMIT_MAX } from '../tools/calls.js';
import { renderRecentNotification } from '../tools/situation.js';
import { captureTools, parseToolResponse } from './_helpers.js';
import type { NotificationRepository, NotificationRecord } from '../repositories/interfaces/notification.repository.js';
import type { CallRepository, CallRecord } from '../repositories/interfaces/call.repository.js';

const USER_ID = 'user-n-1';
const getUserId = () => USER_ID;

const notif = (i: number, over: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: `n${i}`,
  package: 'com.wolt.android',
  app_label: 'Wolt',
  title: `Order ${i}`,
  text: 'x'.repeat(600),
  big_text: null,
  category: null,
  channel_id: null,
  ongoing: false,
  posted_at: '2026-09-08T09:00:00.000Z',
  received_at: '2026-09-08T09:00:01.000Z',
  removed_at: null,
  ...over,
});
const call = (i: number, over: Partial<CallRecord> = {}): CallRecord => ({
  id: `c${i}`,
  state: 'idle',
  direction: 'missed',
  number: '+972501234567',
  contact_name: 'Dana',
  person_id: 'p1',
  known_contact: true,
  started_at: '2026-09-08T09:00:00.000Z',
  ended_at: '2026-09-08T09:00:20.000Z',
  duration_s: null,
  call_log_id: `${i}`,
  updated_at: '2026-09-08T09:00:20.000Z',
  ...over,
});

const validateN = (input: unknown) => z.object(queryNotificationsSchema).safeParse(input);
const validateC = (input: unknown) => z.object(queryCallsSchema).safeParse(input);

describe('query_notifications — arg schema', () => {
  it('accepts the documented args and rejects limit > 100 / unknown direction-like values', () => {
    expect(validateN({}).success).toBe(true);
    expect(validateN({ package: 'com.wolt.android', app: 'Wolt', since: '2026-09-08T00:00:00Z', until: '2026-09-09T00:00:00Z', search: 'courier', include_ongoing: true, limit: 100, cursor: encodeCursor(5) }).success).toBe(true);
    expect(validateN({ limit: NOTIFICATION_LIMIT_MAX + 1 }).success).toBe(false);
    expect(validateN({ limit: 0 }).success).toBe(false);
    expect(validateN({ include_ongoing: 'yes' }).success).toBe(false);
  });
});

describe('query_notifications — repo call + cap', () => {
  function setup(rows: NotificationRecord[]) {
    const repo: NotificationRepository = {
      query: vi.fn(async (_u, p) => rows.slice(p.offset ?? 0, (p.offset ?? 0) + (p.limit ?? 50))),
      recent: vi.fn(async () => []),
    };
    const tools = captureTools((s: McpServer) => registerNotificationTools(s, repo, getUserId));
    return { repo, tool: tools.get('query_notifications')! };
  }

  it('passes filters through, excludes ongoing by default, returns { notifications, total }', async () => {
    const { repo, tool } = setup([notif(0), notif(1)]);
    const res = await tool({ package: 'com.wolt.android', search: 'courier', limit: 10 });
    expect(res.isError).toBeFalsy();
    const out = parseToolResponse<{ notifications: NotificationRecord[]; total: number; truncated?: boolean }>(res);
    expect(out.notifications.map((n) => n.id)).toEqual(['n0', 'n1']);
    expect(out.total).toBe(2);
    expect(out.truncated).toBeUndefined();
    expect(repo.query).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ package: 'com.wolt.android', search: 'courier', include_ongoing: false, limit: 11 }));
  });

  it('caps a large page at ~20 KB at item boundaries with next_cursor', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => notif(i));
    const { tool } = setup(rows);
    const res = await tool({ limit: 100 });
    expect(res.content[0].text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);
    const out = parseToolResponse<{ notifications: NotificationRecord[]; truncated?: boolean; next_cursor?: string; hint?: string }>(res);
    expect(out.notifications.length).toBeGreaterThan(5);
    expect(out.notifications.length).toBeLessThan(100);
    for (const n of out.notifications) expect(n.text.length).toBe(600);
    expect(out.truncated).toBe(true);
    expect(decodeCursor(out.next_cursor)).toBe(out.notifications.length);
    expect(out.hint).toMatch(/package/);
    // the cursor continues from where the cap cut
    const next = parseToolResponse<{ notifications: NotificationRecord[] }>(await tool({ limit: 100, cursor: out.next_cursor }));
    expect(next.notifications[0].id).toBe(`n${out.notifications.length}`);
  });

  it('a bad cursor is an isError envelope', async () => {
    const { tool } = setup([]);
    const res = await tool({ cursor: 'not-a-cursor' });
    expect(res.isError).toBe(true);
  });
});

describe('query_calls — arg schema + envelope', () => {
  it('accepts the documented args; rejects an unknown direction and limit > 100', () => {
    expect(validateC({}).success).toBe(true);
    expect(validateC({ since: '2026-09-01T00:00:00Z', until: '2026-09-08T00:00:00Z', direction: 'missed', number: '0501234567', contact: 'Dana', limit: 100 }).success).toBe(true);
    expect(validateC({ direction: 'sideways' }).success).toBe(false);
    expect(validateC({ limit: CALL_LIMIT_MAX + 1 }).success).toBe(false);
  });

  it('returns { calls, total } and passes the filters to the repository', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => call(i));
    const repo: CallRepository = {
      query: vi.fn(async (_u, p) => rows.slice(0, p.limit)),
      getActive: vi.fn(async () => null),
      recentMissed: vi.fn(async () => []),
    };
    const tool = captureTools((s: McpServer) => registerCallTools(s, repo, getUserId)).get('query_calls')!;
    const out = parseToolResponse<{ calls: CallRecord[]; total: number; truncated?: boolean }>(await tool({ direction: 'missed', contact: 'Dana' }));
    expect(out.calls.length).toBe(3);
    expect(out.total).toBe(3);
    expect(out.truncated).toBeUndefined();
    expect(repo.query).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ direction: 'missed', contact: 'Dana', limit: 51 }));
  });

  it('caps and paginates like every other read tool', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => call(i, { contact_name: 'D'.repeat(400) }));
    const repo: CallRepository = {
      query: vi.fn(async (_u, p) => rows.slice(p.offset ?? 0, (p.offset ?? 0) + (p.limit ?? 50))),
      getActive: vi.fn(async () => null),
      recentMissed: vi.fn(async () => []),
    };
    const tool = captureTools((s: McpServer) => registerCallTools(s, repo, getUserId)).get('query_calls')!;
    const res = await tool({ limit: 100 });
    expect(res.content[0].text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);
    const out = parseToolResponse<{ calls: CallRecord[]; truncated?: boolean; next_cursor?: string }>(res);
    expect(out.truncated).toBe(true);
    expect(decodeCursor(out.next_cursor)).toBe(out.calls.length);
  });
});

describe('get_situation.recent_notifications line', () => {
  it('renders HH:MM app: title — text (text clipped to 80 chars) in the effective timezone', () => {
    const line = renderRecentNotification(notif(1, { text: 'y'.repeat(100) }), 'Asia/Jerusalem');
    expect(line.startsWith('12:00 Wolt: Order 1 — ')).toBe(true);
    expect(line.length).toBe('12:00 Wolt: Order 1 — '.length + 80 + 1);
    expect(renderRecentNotification(notif(2, { text: null }), 'UTC')).toBe('09:00 Wolt: Order 2');
    expect(renderRecentNotification(notif(3, { app_label: null, title: null, text: 'hi' }), 'UTC')).toBe('09:00 com.wolt.android: hi');
  });
});
