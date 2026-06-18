import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';

const raiseAlert = vi.fn(async () => {});
const clearAlert = vi.fn(async () => {});
vi.mock('../utils/alerting.js', () => ({
  raiseAlert: (...a: unknown[]) => raiseAlert(...a),
  clearAlert: (...a: unknown[]) => clearAlert(...a),
}));

import { CalendarSyncScheduler, isGoogleAuthError } from '../scheduler/calendar-sync.js';

const USER = 'u1';
const es = { bulk: vi.fn(async () => ({ errors: false })) } as unknown as Client;
const pool = {} as unknown as Pool;

function makeScheduler(getEvents: () => Promise<unknown>) {
  const client = { getEvents } as unknown as import('../scheduler/google-calendar-client.js').GoogleCalendarClient;
  return new CalendarSyncScheduler(es, client, USER, pool);
}

describe('isGoogleAuthError — classifier', () => {
  it('matches real OAuth failures', () => {
    for (const m of [
      'Google MCP API /api/events returned 500: {"error":"Failed to refresh Google access token: invalid_grant"}',
      'Google MCP API /api/events returned 500: {"error":"Google account not connected. Use get_auth_url to start OAuth flow."}',
      'Token has been expired or revoked.',
    ]) expect(isGoogleAuthError(m)).toBe(true);
  });
  it('does NOT match transient / MCP-auth errors', () => {
    for (const m of [
      'Google MCP API /api/events returned 502: Bad Gateway',
      'fetch failed',
      'Google MCP API /api/events returned 401: {"error":"Invalid credentials"}', // gateway↔MCP key, not OAuth
      'Elasticsearch bulk error',
    ]) expect(isGoogleAuthError(m)).toBe(false);
  });
});

describe('CalendarSyncScheduler — OAuth liveness', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); (es.bulk as ReturnType<typeof vi.fn>).mockClear(); });

  it('raises service.google-auth (critical) on an OAuth failure', async () => {
    const s = makeScheduler(async () => { throw new Error('returned 500: {"error":"Failed to refresh Google access token: invalid_grant"}'); });
    await s.sync();
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert.mock.calls[0][1]).toMatchObject({ key: 'service.google-auth', severity: 'critical' });
    expect(clearAlert).not.toHaveBeenCalled();
  });

  it('does NOT alert on a transient fetch failure', async () => {
    const s = makeScheduler(async () => { throw new Error('fetch failed'); });
    await s.sync();
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('clears service.google-auth on a successful fetch', async () => {
    const s = makeScheduler(async () => []);
    await s.sync();
    expect(clearAlert).toHaveBeenCalledTimes(1);
    expect(clearAlert.mock.calls[0][2]).toBe('service.google-auth');
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});
