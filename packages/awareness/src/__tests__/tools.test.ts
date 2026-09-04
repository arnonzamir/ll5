import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @ll5/shared so logAudit / formatTime don't write to ES during tests.
// Hoisted before any tool module imports it.
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ll5/shared');
  return {
    ...actual,
    logAudit: vi.fn(),
    // Deterministic, predictable formatter so tests don't depend on TZ.
    formatTime: vi.fn((input: string | Date) => ({
      utc: typeof input === 'string' ? input : input.toISOString(),
      local: 'local-stub',
      tz: 'UTC',
    })),
    sessionTimezone: vi.fn(() => 'UTC'),
  };
});

import { logAudit } from '@ll5/shared';
import {
  getTimePeriod,
  getDayType,
  getSuggestedEnergy,
  formatTimeUntil,
} from '../types/situation.js';
import { computeFreshness } from '../types/location.js';
import { registerMessageTools } from '../tools/messages.js';
import { registerSituationTools } from '../tools/situation.js';
import { registerJournalTools } from '../tools/journal.js';
import { captureTools, parseToolResponse, makeMockEsClient } from './_helpers.js';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { CalendarEventRepository } from '../repositories/interfaces/calendar-event.repository.js';
import type { NotableEventRepository } from '../repositories/interfaces/notable-event.repository.js';
import type { LocationService, CurrentLocation } from '../services/location-service.js';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

// ---------------------------------------------------------------------------
// Repository stub factories — every method asserts user_id is forwarded.
// Tests override only the methods they exercise.
// ---------------------------------------------------------------------------

function makeMessageRepo(overrides: Partial<MessageRepository> = {}): MessageRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`MessageRepository.${name} not stubbed for this test`);
  });
  return {
    query: unimpl('query'),
    create: unimpl('create'),
    countActiveConversations: unimpl('countActiveConversations'),
    // Visibility is only computed when results carry conversation_ids;
    // default to an empty map so plain-query tests stay unaffected.
    getConversationVisibility: vi.fn(async () => ({})),
    ...overrides,
  } as MessageRepository;
}

function makeLocationRepo(overrides: Partial<LocationRepository> = {}): LocationRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`LocationRepository.${name} not stubbed for this test`);
  });
  return {
    getLatest: unimpl('getLatest'),
    // Default to an empty trail; history-specific tests override.
    query: vi.fn(async () => []),
    delete: unimpl('delete'),
    create: unimpl('create'),
    ...overrides,
  } as LocationRepository;
}

function makeCalendarRepo(overrides: Partial<CalendarEventRepository> = {}): CalendarEventRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`CalendarEventRepository.${name} not stubbed for this test`);
  });
  return {
    query: unimpl('query'),
    getNext: unimpl('getNext'),
    upsert: unimpl('upsert'),
    ...overrides,
  } as CalendarEventRepository;
}

function makeNotableRepo(overrides: Partial<NotableEventRepository> = {}): NotableEventRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`NotableEventRepository.${name} not stubbed for this test`);
  });
  return {
    create: unimpl('create'),
    queryUnacknowledged: unimpl('queryUnacknowledged'),
    acknowledge: unimpl('acknowledge'),
    ...overrides,
  } as NotableEventRepository;
}

/** Stub LocationService — get_situation only calls getCurrentLocation. */
function makeLocationService(
  returnValue: CurrentLocation | (() => Promise<CurrentLocation>),
): LocationService {
  const getCurrentLocation =
    typeof returnValue === 'function'
      ? vi.fn(returnValue)
      : vi.fn(async () => returnValue);
  return { getCurrentLocation } as unknown as LocationService;
}

const NONE_LOCATION: CurrentLocation = {
  place: null, place_id: null, confidence: 'unknown', source: 'none', reasoning: 'No recent GPS or wifi signal',
};

// ===========================================================================
// PURE HELPER TESTS (kept from original — these were already real)
// ===========================================================================

describe('situation helpers', () => {
  describe('getTimePeriod', () => {
    it('returns morning for hours 6-11', () => {
      expect(getTimePeriod(6)).toBe('morning');
      expect(getTimePeriod(11)).toBe('morning');
    });

    it('returns afternoon for hours 12-16', () => {
      expect(getTimePeriod(12)).toBe('afternoon');
      expect(getTimePeriod(16)).toBe('afternoon');
    });

    it('returns evening for hours 17-20', () => {
      expect(getTimePeriod(17)).toBe('evening');
      expect(getTimePeriod(20)).toBe('evening');
    });

    it('returns night for hours 21-5', () => {
      expect(getTimePeriod(0)).toBe('night');
      expect(getTimePeriod(3)).toBe('night');
      expect(getTimePeriod(5)).toBe('night');
      expect(getTimePeriod(21)).toBe('night');
      expect(getTimePeriod(23)).toBe('night');
    });
  });

  describe('getDayType', () => {
    it('returns weekend for Friday (5) and Saturday (6)', () => {
      expect(getDayType(5)).toBe('weekend');
      expect(getDayType(6)).toBe('weekend');
    });

    it('returns weekday for Sunday through Thursday', () => {
      expect(getDayType(0)).toBe('weekday');
      expect(getDayType(1)).toBe('weekday');
      expect(getDayType(4)).toBe('weekday');
    });
  });

  describe('getSuggestedEnergy', () => {
    it('returns high for morning', () => {
      expect(getSuggestedEnergy('morning')).toBe('high');
    });

    it('returns medium for afternoon and evening', () => {
      expect(getSuggestedEnergy('afternoon')).toBe('medium');
      expect(getSuggestedEnergy('evening')).toBe('medium');
    });

    it('returns low for night', () => {
      expect(getSuggestedEnergy('night')).toBe('low');
    });
  });

  describe('formatTimeUntil', () => {
    it('returns "already started" for past times', () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      expect(formatTimeUntil(past)).toBe('already started');
    });

    it('returns minutes for times less than 1 hour away', () => {
      const future = new Date(Date.now() + 30 * 60_000).toISOString();
      const result = formatTimeUntil(future);
      expect(result).toMatch(/^in \d+ minutes?$/);
    });

    it('returns hours and minutes for times less than 24 hours away', () => {
      const future = new Date(Date.now() + 2.5 * 60 * 60_000).toISOString();
      const result = formatTimeUntil(future);
      expect(result).toMatch(/^in \d+ hours? and \d+ minutes?$/);
    });

    it('returns days for times more than 24 hours away', () => {
      const future = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
      const result = formatTimeUntil(future);
      expect(result).toMatch(/^in \d+ days?$/);
    });

    it('returns clean hours when minutes are zero', () => {
      const future = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
      const result = formatTimeUntil(future);
      // Could be "in 2 hours and 59 minutes" or "in 3 hours" depending on timing
      expect(result).toMatch(/^in \d+ hours?/);
    });
  });
});

describe('computeFreshness', () => {
  it('returns live for timestamps less than 5 minutes ago', () => {
    const recent = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(computeFreshness(recent)).toBe('live');
  });

  it('returns recent for timestamps 5-30 minutes ago', () => {
    const recent = new Date(Date.now() - 15 * 60_000).toISOString();
    expect(computeFreshness(recent)).toBe('recent');
  });

  it('returns stale for timestamps 30-120 minutes ago', () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(computeFreshness(stale)).toBe('stale');
  });

  it('returns unknown for timestamps more than 120 minutes ago', () => {
    const old = new Date(Date.now() - 180 * 60_000).toISOString();
    expect(computeFreshness(old)).toBe('unknown');
  });
});

// ===========================================================================
// REAL TOOL HANDLER TESTS — invoke registerXxxTools, capture the registered
// handler, drive it against stub repos / mock ES clients.
// ===========================================================================

describe('query_im_messages tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards every filter param (and user_id) to repo.query', async () => {
    const query = vi.fn(async () => []);
    const repo = makeMessageRepo({ query });
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));

    await tools.get('query_im_messages')!({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      sender: 'Alice',
      app: 'whatsapp',
      keyword: 'urgent',
      conversation_id: 'conv-1',
      is_group: false,
      limit: 25,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(USER_ID);
    expect(query.mock.calls[0][1]).toEqual({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      sender: 'Alice',
      app: 'whatsapp',
      keyword: 'urgent',
      conversation_id: 'conv-1',
      is_group: false,
      // ISS-019: the handler asks for one probe row past the page (limit + 1)
      // so `truncated`/`next_cursor` are exact; the probe row is never returned.
      limit: 26,
    });
  });

  it('omits missing filter keys as undefined; only the page size (default 50 + 1 probe) is set', async () => {
    const query = vi.fn(async () => []);
    const repo = makeMessageRepo({ query });
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));

    await tools.get('query_im_messages')!({ sender: 'Alice' });

    expect(query.mock.calls[0][0]).toBe(USER_ID);
    const params = query.mock.calls[0][1];
    expect(params.sender).toBe('Alice');
    expect(params.app).toBeUndefined();
    expect(params.keyword).toBeUndefined();
    expect(params.limit).toBe(51); // ISS-019: default page 50 + 1 probe row
    expect(params.offset).toBeUndefined(); // first page: no offset sent
  });

  it('returns messages and total in the response envelope', async () => {
    const messages = [
      { id: 'msg-1', sender: 'Alice', app: 'whatsapp', content: 'hi', timestamp: '2026-04-06T10:00:00Z', is_group: false, conversation_id: null, conversation_name: null, relevance_score: null },
      { id: 'msg-2', sender: 'Bob', app: 'telegram', content: 'urgent', timestamp: '2026-04-06T10:05:00Z', is_group: false, conversation_id: null, conversation_name: null, relevance_score: 1.5 },
    ];
    const repo = makeMessageRepo({ query: vi.fn(async () => messages) });
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));

    const response = await tools.get('query_im_messages')!({});

    const parsed = parseToolResponse<{ messages: Array<{ id: string }>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
  });
});

describe('get_situation tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  function buildRepos(over: {
    calendar?: CalendarEventRepository;
    notableEvent?: NotableEventRepository;
    message?: MessageRepository;
  } = {}) {
    return {
      // location repo is no longer read directly by get_situation (fusion service
      // owns the read) — keep an unstubbed stub so an accidental direct call throws.
      location: makeLocationRepo(),
      calendar: over.calendar ?? makeCalendarRepo({ getNext: vi.fn(async () => null) }),
      notableEvent: over.notableEvent ?? makeNotableRepo({ queryUnacknowledged: vi.fn(async () => []) }),
      message: over.message ?? makeMessageRepo({ countActiveConversations: vi.fn(async () => 0) }),
    };
  }

  it('forwards user_id to every data source (location via fusion service)', async () => {
    const getNext = vi.fn(async () => null);
    const queryUnacknowledged = vi.fn(async () => []);
    const countActiveConversations = vi.fn(async () => 0);

    const repos = buildRepos({
      calendar: makeCalendarRepo({ getNext }),
      notableEvent: makeNotableRepo({ queryUnacknowledged }),
      message: makeMessageRepo({ countActiveConversations }),
    });
    const svc = makeLocationService(NONE_LOCATION);

    const tools = captureTools((s) => registerSituationTools(s, repos, getUserId, 'UTC', svc));
    await tools.get('get_situation')!({});

    expect(svc.getCurrentLocation).toHaveBeenCalledWith(USER_ID);
    expect(getNext).toHaveBeenCalledWith(USER_ID);
    expect(queryUnacknowledged).toHaveBeenCalledWith(USER_ID, {});
    expect(countActiveConversations).toHaveBeenCalledTimes(1);
    expect(countActiveConversations.mock.calls[0][0]).toBe(USER_ID);
    // The since arg is computed inside the handler — assert shape only.
    expect(typeof countActiveConversations.mock.calls[0][1]).toBe('string');
  });

  it('assembles a complete situation from every data source', async () => {
    const locationTs = new Date(Date.now() - 2 * 60_000).toISOString();
    const eventStart = new Date(Date.now() + 30 * 60_000).toISOString();
    const repos = buildRepos({
      calendar: makeCalendarRepo({
        getNext: vi.fn(async () => ({
          id: 'evt-1', userId: USER_ID, title: 'Team standup',
          startTime: eventStart, endTime: eventStart,
          location: 'Zoom',
          createdAt: locationTs, updatedAt: locationTs,
        })),
      }),
      notableEvent: makeNotableRepo({
        queryUnacknowledged: vi.fn(async () => [{
          id: 'n1', userId: USER_ID,
          type: 'location_change',
          summary: 'Arrived at home',
          details: { severity: 'medium' },
          acknowledged: false,
          timestamp: locationTs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any]),
      }),
      message: makeMessageRepo({ countActiveConversations: vi.fn(async () => 3) }),
    });
    const svc = makeLocationService({
      place: 'Home', place_id: 'p-1', confidence: 'high', source: 'gps',
      reasoning: 'GPS fix (120s old) at Home',
      description: 'Home', motion: 'stationary', speed_mps: 0, speed_kmh: 0, trail: [],
      position: {
        lat: 32.0853, lon: 34.7818, accuracy_m: 10, precision: 'high',
        timestamp: locationTs, age_s: 120, freshness: 'live',
        road: null, neighborhood: null, city: 'Tel Aviv', address: 'Tel Aviv',
      },
    });

    const tools = captureTools((s) => registerSituationTools(s, repos, getUserId, 'UTC', svc));
    const response = await tools.get('get_situation')!({});

    const parsed = parseToolResponse<{ situation: Record<string, unknown> }>(response);
    const sit = parsed.situation;
    expect(sit.timezone).toBe('UTC');
    // current_location is now the SAME rich snapshot where_is_user returns.
    const loc = sit.current_location as Record<string, unknown>;
    const pos = loc.position as Record<string, unknown>;
    expect(pos.lat).toBe(32.0853);
    expect(pos.lon).toBe(34.7818);
    expect(loc.place).toBe('Home');
    expect(pos.freshness).toBe('live');
    expect(loc.confidence).toBe('high');
    expect(loc.source).toBe('gps');
    expect(loc.reasoning).toBe('GPS fix (120s old) at Home');

    const ev = sit.next_event as Record<string, unknown>;
    expect(ev.title).toBe('Team standup');
    expect(ev.location).toBe('Zoom');

    const notable = sit.notable_recent_events as Array<Record<string, unknown>>;
    expect(notable).toHaveLength(1);
    expect(notable[0].event_type).toBe('location_change');
    expect(notable[0].severity).toBe('medium');

    expect(sit.active_conversations).toBe(3);
  });

  it('surfaces confidence/source/reasoning and resolves place via wifi BSSID when GPS is stale', async () => {
    const repos = buildRepos();
    const svc = makeLocationService({
      place: 'Office', place_id: 'p-2', confidence: 'medium', source: 'wifi',
      reasoning: 'GPS stale (1200s), wifi BSSID maps to Office',
      description: 'Office', motion: 'unknown', speed_mps: null, speed_kmh: null, trail: [],
      position: {
        lat: 32.1, lon: 34.8, accuracy_m: 20, precision: 'high',
        timestamp: '2026-06-12T09:40:00.000Z', age_s: 1200, freshness: 'stale',
        road: null, neighborhood: null, city: null, address: null,
      },
      wifi: {
        bssid: 'aa:bb:cc:dd:ee:ff', ssid: 'OfficeWifi', connected: true, age_s: 30,
        place_from_bssid: { place_id: 'p-2', place_name: 'Office' },
      },
    });

    const tools = captureTools((s) => registerSituationTools(s, repos, getUserId, 'UTC', svc));
    const response = await tools.get('get_situation')!({});

    const loc = parseToolResponse<{ situation: { current_location: Record<string, unknown> } }>(response)
      .situation.current_location;
    // Place comes from the wifi BSSID resolution, not raw GPS (which had none).
    expect(loc.place).toBe('Office');
    expect((loc.wifi as { place_from_bssid?: { place_name?: string } }).place_from_bssid?.place_name).toBe('Office');
    expect(loc.confidence).toBe('medium');
    expect(loc.source).toBe('wifi');
    expect(loc.reasoning).toMatch(/wifi BSSID maps to Office/);
  });

  it('treats source=none location and null event as missing, not as error', async () => {
    const repos = buildRepos();
    const svc = makeLocationService(NONE_LOCATION);
    const tools = captureTools((s) => registerSituationTools(s, repos, getUserId, 'UTC', svc));

    const response = await tools.get('get_situation')!({});
    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ situation: Record<string, unknown> }>(response);
    expect(parsed.situation.current_location).toBeNull();
    expect(parsed.situation.next_event).toBeNull();
    expect(parsed.situation.notable_recent_events).toEqual([]);
    expect(parsed.situation.active_conversations).toBe(0);
  });

  it('swallows per-source errors and still returns a partial situation', async () => {
    const repos = buildRepos({
      calendar: makeCalendarRepo({ getNext: vi.fn(async () => { throw new Error('cal down'); }) }),
      notableEvent: makeNotableRepo({ queryUnacknowledged: vi.fn(async () => []) }),
      message: makeMessageRepo({ countActiveConversations: vi.fn(async () => 7) }),
    });
    const svc = makeLocationService(async () => { throw new Error('es down'); });

    const tools = captureTools((s) => registerSituationTools(s, repos, getUserId, 'UTC', svc));
    const response = await tools.get('get_situation')!({});

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ situation: Record<string, unknown> }>(response);
    // Failed sources -> nulls / empties; message source still got through.
    expect(parsed.situation.current_location).toBeNull();
    expect(parsed.situation.next_event).toBeNull();
    expect(parsed.situation.active_conversations).toBe(7);
  });
});

// ===========================================================================
// Journal & user-model tool handler tests — these tools take a Client directly,
// so we mock the ES verbs (index/search/get/update/updateByQuery) and assert
// the calls forwarded user_id in the query DSL / document.
// ===========================================================================

describe('write_journal tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('indexes a journal entry scoped to user_id and returns the id', async () => {
    const esClient = makeMockEsClient({
      index: vi.fn().mockResolvedValue({ _id: 'j-new', result: 'created' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('write_journal')!({
      type: 'observation',
      topic: 'Sleep pattern',
      content: 'Slept late again',
      signal: 'pattern',
    });

    expect(esClient.index).toHaveBeenCalledTimes(1);
    const call = (esClient.index as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_agent_journal');
    expect(call.refresh).toBe('wait_for');
    expect(call.document).toMatchObject({
      user_id: USER_ID,
      type: 'observation',
      topic: 'Sleep pattern',
      content: 'Slept late again',
      signal: 'pattern',
      status: 'open',
    });

    const parsed = parseToolResponse<{ id: string; topic: string; status: string }>(response);
    expect(parsed.id).toBe('j-new');
    expect(parsed.topic).toBe('Sleep pattern');
    expect(parsed.status).toBe('open');
  });

  it('defaults signal to null when not provided', async () => {
    const esClient = makeMockEsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await tools.get('write_journal')!({
      type: 'thought',
      topic: 'X',
      content: 'Y',
    });

    const call = (esClient.index as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.document.signal).toBeNull();
    expect(call.document.session_id).toBeNull();
  });

  it('emits an audit log entry on successful write', async () => {
    const esClient = makeMockEsClient({
      index: vi.fn().mockResolvedValue({ _id: 'j-77', result: 'created' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await tools.get('write_journal')!({ type: 'feedback', topic: 'T', content: 'C' });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'awareness',
      action: 'create',
      entity_type: 'journal',
      entity_id: 'j-77',
    }));
  });
});

describe('read_journal tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries ES with user_id and default status=open', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await tools.get('read_journal')!({});

    expect(esClient.search).toHaveBeenCalledTimes(1);
    const call = (esClient.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_agent_journal');
    expect(call.size).toBe(20);
    expect(call.query.bool.must).toEqual([
      { term: { user_id: USER_ID } },
      { term: { status: 'open' } },
    ]);
  });

  it('layers in optional filters (status, type, topic, since)', async () => {
    const esClient = makeMockEsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await tools.get('read_journal')!({
      status: 'resolved',
      type: 'decision',
      topic: 'health',
      since: '2026-04-01T00:00:00Z',
      limit: 5,
    });

    const call = (esClient.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.size).toBe(5);
    expect(call.query.bool.must).toEqual([
      { term: { user_id: USER_ID } },
      { term: { status: 'resolved' } },
      { term: { type: 'decision' } },
      { match: { topic: 'health' } },
      { range: { created_at: { gte: '2026-04-01T00:00:00Z' } } },
    ]);
  });

  it('maps hits into the response envelope (id + source fields)', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [
            { _id: 'j1', _source: { user_id: USER_ID, type: 'observation', topic: 'Sleep', content: 'Late', status: 'open', created_at: '2026-04-06T10:00:00Z', updated_at: '2026-04-06T10:00:00Z' } },
            { _id: 'j2', _source: { user_id: USER_ID, type: 'feedback', topic: 'Diet', content: 'Good', status: 'open', created_at: '2026-04-06T09:00:00Z', updated_at: '2026-04-06T09:00:00Z' } },
          ],
        },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('read_journal')!({});

    const parsed = parseToolResponse<{ entries: Array<{ id: string; topic: string }>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.entries.map((e) => e.id)).toEqual(['j1', 'j2']);
    expect(parsed.entries[0].topic).toBe('Sleep');
  });
});

describe('resolve_journal tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates a single entry by entry_id', async () => {
    const esClient = makeMockEsClient({
      get: vi.fn().mockResolvedValue({ _id: 'j1', _source: { user_id: USER_ID, status: 'open' } }),
      update: vi.fn().mockResolvedValue({ result: 'updated' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('resolve_journal')!({ entry_id: 'j1' });

    expect(esClient.update).toHaveBeenCalledTimes(1);
    const call = (esClient.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_agent_journal');
    expect(call.id).toBe('j1');
    expect(call.doc.status).toBe('resolved');
    expect(typeof call.doc.updated_at).toBe('string');

    const parsed = parseToolResponse<{ resolved_count: number }>(response);
    expect(parsed.resolved_count).toBe(1);
  });

  it('resolves by topic using updateByQuery scoped to user_id', async () => {
    const esClient = makeMockEsClient({
      updateByQuery: vi.fn().mockResolvedValue({ updated: 3 }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('resolve_journal')!({ topic: 'Sleep' });

    expect(esClient.updateByQuery).toHaveBeenCalledTimes(1);
    const call = (esClient.updateByQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_agent_journal');
    expect(call.query.bool.must).toEqual([
      { term: { user_id: USER_ID } },
      { term: { status: 'open' } },
      { term: { 'topic.keyword': 'Sleep' } },
    ]);
    expect(call.script.source).toContain("status = 'resolved'");

    const parsed = parseToolResponse<{ resolved_count: number }>(response);
    expect(parsed.resolved_count).toBe(3);
  });

  it('returns resolved_count=0 when neither entry_id nor topic is provided', async () => {
    const esClient = makeMockEsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('resolve_journal')!({});

    expect(esClient.update).not.toHaveBeenCalled();
    expect(esClient.updateByQuery).not.toHaveBeenCalled();
    const parsed = parseToolResponse<{ resolved_count: number }>(response);
    expect(parsed.resolved_count).toBe(0);
  });

  it('emits an audit log even when nothing was resolved (topic branch)', async () => {
    const esClient = makeMockEsClient({
      updateByQuery: vi.fn().mockResolvedValue({ updated: 0 }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await tools.get('resolve_journal')!({ topic: 'Nothing' });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'awareness',
      action: 'update',
      entity_type: 'journal',
      entity_id: 'topic:Nothing',
    }));
  });
});

describe('read_user_model tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches one section by composite id (user_id + section)', async () => {
    const esClient = makeMockEsClient({
      get: vi.fn().mockResolvedValue({
        _id: `${USER_ID}_communication`,
        _source: {
          user_id: USER_ID,
          section: 'communication',
          content: { preferred_channels: ['whatsapp'] },
          last_updated: '2026-04-06T10:00:00Z',
        },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('read_user_model')!({ section: 'communication' });

    expect(esClient.get).toHaveBeenCalledWith({
      index: 'll5_agent_user_model',
      id: `${USER_ID}_communication`,
    });
    const parsed = parseToolResponse<{ section: string; content: Record<string, unknown> }>(response);
    expect(parsed.section).toBe('communication');
    expect(parsed.content.preferred_channels).toEqual(['whatsapp']);
  });

  it('returns {section: null} on 404, not an error envelope', async () => {
    const notFound = new Error('not found');
    Object.assign(notFound, { meta: { statusCode: 404 } });
    const esClient = makeMockEsClient({
      get: vi.fn().mockRejectedValue(notFound),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('read_user_model')!({ section: 'goals' });

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ section: null }>(response);
    expect(parsed.section).toBeNull();
  });

  it('rethrows non-404 errors (e.g. ES down)', async () => {
    const esClient = makeMockEsClient({
      get: vi.fn().mockRejectedValue(new Error('es down')),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await expect(tools.get('read_user_model')!({ section: 'goals' })).rejects.toThrow('es down');
  });

  it('lists all sections scoped to user_id when no section is provided', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [
            { _id: `${USER_ID}_communication`, _source: { user_id: USER_ID, section: 'communication', content: {}, last_updated: '2026-04-06' } },
            { _id: `${USER_ID}_routines`,      _source: { user_id: USER_ID, section: 'routines',      content: {}, last_updated: '2026-04-06' } },
          ],
        },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('read_user_model')!({});

    const call = (esClient.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_agent_user_model');
    expect(call.query).toEqual({ term: { user_id: USER_ID } });

    const parsed = parseToolResponse<{ sections: Array<{ section: string }> }>(response);
    expect(parsed.sections.map((s) => s.section)).toEqual(['communication', 'routines']);
  });
});

describe('write_user_model tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('snapshots existing version to history before overwriting', async () => {
    const existingSource = {
      user_id: USER_ID,
      section: 'goals',
      content: { short_term: ['exercise'] },
      last_updated: '2026-04-05T10:00:00Z',
    };
    const esClient = makeMockEsClient({
      get: vi.fn().mockResolvedValue({ _source: existingSource }),
      index: vi.fn().mockResolvedValue({ _id: 'whatever', result: 'created' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await tools.get('write_user_model')!({
      section: 'goals',
      content: { short_term: ['exercise', 'read'] },
    });

    expect(esClient.get).toHaveBeenCalledWith({ index: 'll5_agent_user_model', id: `${USER_ID}_goals` });
    expect(esClient.index).toHaveBeenCalledTimes(2);

    const indexCalls = (esClient.index as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    // First: history snapshot
    expect(indexCalls[0].index).toBe('ll5_agent_user_model_history');
    expect(indexCalls[0].document).toMatchObject({
      user_id: USER_ID,
      section: 'goals',
      original_id: `${USER_ID}_goals`,
    });
    expect(typeof indexCalls[0].document.archived_at).toBe('string');

    // Second: write new version
    expect(indexCalls[1].index).toBe('ll5_agent_user_model');
    expect(indexCalls[1].id).toBe(`${USER_ID}_goals`);
    expect(indexCalls[1].document).toMatchObject({
      user_id: USER_ID,
      section: 'goals',
      content: { short_term: ['exercise', 'read'] },
    });
  });

  it('skips history snapshot when no existing version exists', async () => {
    const esClient = makeMockEsClient({
      get: vi.fn().mockRejectedValue(new Error('Not found')),
      index: vi.fn().mockResolvedValue({ _id: 'whatever', result: 'created' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await tools.get('write_user_model')!({
      section: 'goals',
      content: { short_term: ['exercise'] },
    });

    expect(esClient.index).toHaveBeenCalledTimes(1);
    const call = (esClient.index as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_agent_user_model');
    expect(call.document.user_id).toBe(USER_ID);
  });

  it('emits an audit log entry referencing the composite section id', async () => {
    const esClient = makeMockEsClient({
      get: vi.fn().mockRejectedValue(new Error('Not found')),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    await tools.get('write_user_model')!({ section: 'goals', content: {} });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'awareness',
      action: 'update',
      entity_type: 'user_model',
      entity_id: `${USER_ID}_goals`,
    }));
  });
});

describe('list_user_model_versions tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('searches history index scoped by user_id and section', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [
            { _id: 'v1', _source: { section: 'goals', last_updated: '2026-04-05T10:00:00Z', archived_at: '2026-04-06T10:00:00Z' } },
            { _id: 'v2', _source: { section: 'goals', last_updated: '2026-04-04T10:00:00Z', archived_at: '2026-04-05T10:00:00Z' } },
          ],
        },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('list_user_model_versions')!({ section: 'goals', limit: 5 });

    const call = (esClient.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_agent_user_model_history');
    expect(call.size).toBe(5);
    expect(call.query.bool.filter).toEqual([
      { term: { user_id: USER_ID } },
      { term: { section: 'goals' } },
    ]);

    const parsed = parseToolResponse<{ versions: Array<{ id: string }>; count: number }>(response);
    expect(parsed.count).toBe(2);
    expect(parsed.versions.map((v) => v.id)).toEqual(['v1', 'v2']);
  });
});

describe('get_user_model_version tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the historical version when it belongs to the caller', async () => {
    const esClient = makeMockEsClient({
      get: vi.fn().mockResolvedValue({
        _id: 'v1',
        _source: {
          user_id: USER_ID,
          section: 'goals',
          content: { x: 1 },
          last_updated: '2026-04-05T10:00:00Z',
          archived_at: '2026-04-06T10:00:00Z',
        },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('get_user_model_version')!({ version_id: 'v1' });

    expect(esClient.get).toHaveBeenCalledWith({ index: 'll5_agent_user_model_history', id: 'v1' });
    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ section: string; content: Record<string, unknown> }>(response);
    expect(parsed.section).toBe('goals');
    expect(parsed.content.x).toBe(1);
  });

  it('refuses to return a version owned by another user (cross-tenant guard)', async () => {
    const esClient = makeMockEsClient({
      get: vi.fn().mockResolvedValue({
        _id: 'v1',
        _source: {
          user_id: 'someone-else',
          section: 'goals',
          content: { x: 1 },
          last_updated: '2026-04-05T10:00:00Z',
          archived_at: '2026-04-06T10:00:00Z',
        },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('get_user_model_version')!({ version_id: 'v1' });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/Not found/);
  });

  it('returns an error envelope when ES throws (e.g. not found)', async () => {
    const esClient = makeMockEsClient({
      get: vi.fn().mockRejectedValue(new Error('not found')),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerJournalTools(s, esClient as any, getUserId));

    const response = await tools.get('get_user_model_version')!({ version_id: 'missing' });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/Version not found/);
  });
});
