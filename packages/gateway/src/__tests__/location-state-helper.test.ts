import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { buildLocationLine, getCurrentPlace } from '../scheduler/location-state.js';

const USER = 'user-1';
const TZ = 'UTC';

function esWithState(source: Record<string, unknown> | null): Client {
  return {
    get: vi.fn(async () => {
      if (source === null) throw { meta: { statusCode: 404 } };
      return { _source: source };
    }),
  } as unknown as Client;
}

describe('getCurrentPlace (A2/A3 helper)', () => {
  it('returns null when no state doc exists', async () => {
    expect(await getCurrentPlace(esWithState(null), USER)).toBeNull();
  });

  it('returns label/kind/lastSeen from the state doc', async () => {
    const es = esWithState({ label: 'Home', kind: 'place', last_seen: '2026-05-30T10:00:00.000Z' });
    expect(await getCurrentPlace(es, USER)).toEqual({
      label: 'Home',
      kind: 'place',
      lastSeen: '2026-05-30T10:00:00.000Z',
    });
  });
});

describe('buildLocationLine (A2/A3 helper)', () => {
  it('builds an "at <place>" line for a known place seen recently', async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const es = esWithState({ label: 'Home', kind: 'place', last_seen: recent });
    const line = await buildLocationLine(es, USER, TZ);
    expect(line).toMatch(/^Location: at Home \(as of \d{2}:\d{2}\)$/);
  });

  it('uses "in" for city-level labels', async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const es = esWithState({ label: 'Tel Aviv', kind: 'city', last_seen: recent });
    const line = await buildLocationLine(es, USER, TZ);
    expect(line).toMatch(/^Location: in Tel Aviv/);
  });

  it('omits the line when the place is too stale', async () => {
    const old = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const es = esWithState({ label: 'Home', kind: 'place', last_seen: old });
    expect(await buildLocationLine(es, USER, TZ)).toBeNull();
  });

  it('returns null gracefully when there is no state', async () => {
    expect(await buildLocationLine(esWithState(null), USER, TZ)).toBeNull();
  });
});
