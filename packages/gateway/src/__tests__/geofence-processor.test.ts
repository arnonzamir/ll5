import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import type { PushGeofenceTransitionItem } from '../types/index.js';
import { processGeofence } from '../processors/geofence.js';

const USER = 'user-geo-1';
const PLACE_ID = 'place-home-1';
const PLACE_NAME = 'Home';

interface IndexCall { index: string; document: Record<string, unknown> }

/**
 * ES mock: `get` on the location-state index returns the provided state (or 404 →
 * no state); `index` calls are captured (notable events + the state write).
 */
function makeEs(state: Record<string, unknown> | null): {
  es: Client;
  indexed: IndexCall[];
  stateWrites: Record<string, unknown>[];
} {
  const indexed: IndexCall[] = [];
  const es = {
    get: vi.fn(async (req: { index: string }) => {
      if (req.index === 'll5_awareness_location_state') {
        if (state === null) throw { meta: { statusCode: 404 } };
        return { _source: { user_id: USER, ...state } };
      }
      // place-name lookup (ll5_knowledge_places) — not needed when place_name given
      throw { meta: { statusCode: 404 } };
    }),
    index: vi.fn(async (req: { index: string; document: Record<string, unknown> }) => {
      indexed.push({ index: req.index, document: req.document });
      return { result: 'created' };
    }),
  } as unknown as Client;
  const stateWrites = () => indexed
    .filter((c) => c.index === 'll5_awareness_location_state')
    .map((c) => c.document);
  return {
    es,
    indexed,
    get stateWrites() { return stateWrites(); },
  } as { es: Client; indexed: IndexCall[]; stateWrites: Record<string, unknown>[] };
}

function makePool(): { pool: Pool; messages: string[] } {
  const messages: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      // insertSystemMessage INSERT returns an id; capture the content (param $2).
      if (/INSERT INTO chat_messages/.test(sql)) {
        messages.push(String(params[1]));
        return { rows: [{ id: 'msg-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
  return { pool, messages };
}

function geo(over: Partial<PushGeofenceTransitionItem>): PushGeofenceTransitionItem {
  return {
    type: 'geofence_transition',
    place_id: PLACE_ID,
    place_name: PLACE_NAME,
    transition: 'dwell',
    lat: 32.1,
    lon: 34.8,
    timestamp: '2026-06-21T10:00:00.000Z',
    ...over,
  } as PushGeofenceTransitionItem;
}

function notableEvents(indexed: IndexCall[]): Record<string, unknown>[] {
  return indexed.filter((c) => c.index === 'll5_awareness_notable_events').map((c) => c.document);
}
function stateWrites(indexed: IndexCall[]): Record<string, unknown>[] {
  return indexed.filter((c) => c.index === 'll5_awareness_location_state').map((c) => c.document);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processGeofence — dwell (confirmed arrival)', () => {
  it('sets location-state to the place and wakes the agent with [geofence]', async () => {
    const { es, indexed } = makeEs(null); // not at any place yet
    const { pool, messages } = makePool();

    await processGeofence(es, USER, geo({ transition: 'dwell' }), pool);

    // State set to the place
    const writes = stateWrites(indexed);
    expect(writes).toHaveLength(1);
    expect(writes[0].kind).toBe('place');
    expect(writes[0].place_id).toBe(PLACE_ID);
    expect(writes[0].label).toBe(PLACE_NAME);

    // Notable "Arrived at" event
    const events = notableEvents(indexed);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe(`Arrived at ${PLACE_NAME}`);

    // Agent wake message, tagged [geofence]
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`[Location] Arrived at ${PLACE_NAME}`);
    expect(messages[0]).toContain('[geofence]');
  });

  it('does NOT double-fire when already at this place (dedup)', async () => {
    const { es, indexed } = makeEs({ label: PLACE_NAME, kind: 'place', place_id: PLACE_ID });
    const { pool, messages } = makePool();

    await processGeofence(es, USER, geo({ transition: 'dwell' }), pool);

    // No state write, no notable event, no wake
    expect(stateWrites(indexed)).toHaveLength(0);
    expect(notableEvents(indexed)).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });
});

describe('processGeofence — exit (departure)', () => {
  it('clears state and wakes "Left <place>" when state was at this place', async () => {
    const { es, indexed } = makeEs({ label: PLACE_NAME, kind: 'place', place_id: PLACE_ID });
    const { pool, messages } = makePool();

    await processGeofence(es, USER, geo({ transition: 'exit' }), pool);

    const writes = stateWrites(indexed);
    expect(writes).toHaveLength(1);
    expect(writes[0].kind).toBe('city'); // cleared to unknown/city
    expect(writes[0].place_id).toBeUndefined();

    const events = notableEvents(indexed);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe(`Left ${PLACE_NAME}`);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`[Location] Left ${PLACE_NAME}`);
    expect(messages[0]).toContain('[geofence]');
  });

  it('only logs (no state clear / no wake) when state was NOT at this place', async () => {
    const { es, indexed } = makeEs({ label: 'Office', kind: 'place', place_id: 'place-office' });
    const { pool, messages } = makePool();

    await processGeofence(es, USER, geo({ transition: 'exit' }), pool);

    expect(stateWrites(indexed)).toHaveLength(0);
    expect(notableEvents(indexed)).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });
});

describe('processGeofence — enter (suppressed)', () => {
  it('does NOT wake, does NOT touch state on enter', async () => {
    const { es, indexed } = makeEs(null);
    const { pool, messages } = makePool();

    await processGeofence(es, USER, geo({ transition: 'enter' }), pool);

    expect(stateWrites(indexed)).toHaveLength(0);
    expect(notableEvents(indexed)).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });
});
