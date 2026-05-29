import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @ll5/shared so logAudit doesn't write to ES and formatTime is deterministic.
// Hoisted before any tool module imports it.
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ll5/shared');
  return {
    ...actual,
    logAudit: vi.fn(),
    formatTime: vi.fn((input: string | Date, _tz?: string) => ({
      utc: typeof input === 'string' ? input : input.toISOString(),
      local: 'local-stub',
      tz: 'UTC',
    })),
    sessionTimezone: vi.fn(() => 'UTC'),
    generateToken: vi.fn(() => 'mock-token-xyz'),
  };
});

import { logAudit } from '@ll5/shared';
import { registerCalendarTools } from '../tools/calendar.js';
import { registerEntityStatusTools } from '../tools/entity-statuses.js';
import { registerLocationTools } from '../tools/location.js';
import { registerMediaTools } from '../tools/media.js';
import { registerNotableEventTools } from '../tools/notable-events.js';
import { registerPhoneStatusTools } from '../tools/phone-status.js';
import { registerWifiTools } from '../tools/wifi.js';
import { captureTools, parseToolResponse, makeMockEsClient } from './_helpers.js';
import type { CalendarEventRepository } from '../repositories/interfaces/calendar-event.repository.js';
import type { EntityStatusRepository } from '../repositories/interfaces/entity-status.repository.js';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { NotableEventRepository } from '../repositories/interfaces/notable-event.repository.js';
import type { PhoneStatusRepository } from '../repositories/interfaces/phone-status.repository.js';
import type { WifiRepository } from '../repositories/interfaces/wifi.repository.js';
import type { LocationService } from '../services/location-service.js';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

// ---------------------------------------------------------------------------
// Repo / service factories (mock at the interface boundary)
// ---------------------------------------------------------------------------

function makeCalendarRepo(over: Partial<CalendarEventRepository> = {}): CalendarEventRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`CalendarEventRepository.${name} not stubbed for this test`);
  });
  return {
    query: unimpl('query'),
    getNext: unimpl('getNext'),
    upsert: unimpl('upsert'),
    ...over,
  } as CalendarEventRepository;
}

function makeEntityStatusRepo(over: Partial<EntityStatusRepository> = {}): EntityStatusRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`EntityStatusRepository.${name} not stubbed for this test`);
  });
  return {
    getByName: unimpl('getByName'),
    listRecent: unimpl('listRecent'),
    upsert: unimpl('upsert'),
    ...over,
  } as EntityStatusRepository;
}

function makeLocationRepo(over: Partial<LocationRepository> = {}): LocationRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`LocationRepository.${name} not stubbed for this test`);
  });
  return {
    getLatest: unimpl('getLatest'),
    query: unimpl('query'),
    delete: unimpl('delete'),
    create: unimpl('create'),
    ...over,
  } as LocationRepository;
}

function makeNotableRepo(over: Partial<NotableEventRepository> = {}): NotableEventRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`NotableEventRepository.${name} not stubbed for this test`);
  });
  return {
    create: unimpl('create'),
    queryUnacknowledged: unimpl('queryUnacknowledged'),
    acknowledge: unimpl('acknowledge'),
    ...over,
  } as NotableEventRepository;
}

function makePhoneStatusRepo(over: Partial<PhoneStatusRepository> = {}): PhoneStatusRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`PhoneStatusRepository.${name} not stubbed for this test`);
  });
  return {
    getLatest: unimpl('getLatest'),
    query: unimpl('query'),
    ...over,
  } as PhoneStatusRepository;
}

function makeWifiRepo(over: Partial<WifiRepository> = {}): WifiRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`WifiRepository.${name} not stubbed for this test`);
  });
  return {
    getLatest: unimpl('getLatest'),
    query: unimpl('query'),
    ...over,
  } as WifiRepository;
}

/** Stub LocationService — only needs getCurrentLocation. */
function makeLocationService(returnValue: Awaited<ReturnType<LocationService['getCurrentLocation']>>): LocationService {
  return {
    getCurrentLocation: vi.fn(async () => returnValue),
  } as unknown as LocationService;
}

// ===========================================================================
// CALENDAR TOOLS — get_calendar_events
// (registerCalendarTools currently NOT wired into registerAllTools — comment in
// tools/index.ts says "Calendar tools retired — unified calendar reads/writes
// go through the calendar MCP". The function is still exported and live in the
// codebase, so we cover it directly to lock down its current contract.)
// ===========================================================================

describe('get_calendar_events tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards every filter to calendarRepo.query scoped by user_id', async () => {
    const query = vi.fn(async () => []);
    const repo = makeCalendarRepo({ query });
    const tools = captureTools((s) => registerCalendarTools(s, repo, getUserId));

    await tools.get('get_calendar_events')!({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      calendar_name: 'work',
      include_all_day: false,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(USER_ID);
    expect(query.mock.calls[0][1]).toEqual({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      calendar_name: 'work',
      include_all_day: false,
    });
  });

  it('maps repo CalendarEvent → flat response shape with start_local and end_local', async () => {
    const repo = makeCalendarRepo({
      query: vi.fn(async () => [{
        id: 'evt-1',
        userId: USER_ID,
        title: 'Team standup',
        startTime: '2026-04-06T09:00:00Z',
        endTime: '2026-04-06T09:30:00Z',
        location: 'Zoom',
        description: 'Daily sync',
        calendarId: 'work-cal',
        allDay: false,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }] as unknown as Awaited<ReturnType<CalendarEventRepository['query']>>),
    });
    const tools = captureTools((s) => registerCalendarTools(s, repo, getUserId));

    const response = await tools.get('get_calendar_events')!({});

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ events: Array<Record<string, unknown>>; total: number; tz: string }>(response);
    expect(parsed.total).toBe(1);
    expect(parsed.tz).toBe('UTC');
    const evt = parsed.events[0];
    expect(evt.id).toBe('evt-1');
    expect(evt.title).toBe('Team standup');
    expect(evt.start).toBe('2026-04-06T09:00:00Z');
    expect(evt.start_local).toBe('local-stub');
    expect(evt.end).toBe('2026-04-06T09:30:00Z');
    expect(evt.location).toBe('Zoom');
    expect(evt.calendar_name).toBe('work-cal');
    expect(evt.all_day).toBe(false);
  });

  it('returns an empty list when repo returns no events', async () => {
    const repo = makeCalendarRepo({ query: vi.fn(async () => []) });
    const tools = captureTools((s) => registerCalendarTools(s, repo, getUserId));

    const response = await tools.get('get_calendar_events')!({});
    const parsed = parseToolResponse<{ events: unknown[]; total: number }>(response);
    expect(parsed.total).toBe(0);
    expect(parsed.events).toEqual([]);
  });

  it('coerces missing endTime/location/description to null', async () => {
    const repo = makeCalendarRepo({
      query: vi.fn(async () => [{
        id: 'evt-noend',
        userId: USER_ID,
        title: 'Open block',
        startTime: '2026-04-06T09:00:00Z',
        endTime: '',
        location: undefined,
        description: undefined,
        calendarId: undefined,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      }] as unknown as Awaited<ReturnType<CalendarEventRepository['query']>>),
    });
    const tools = captureTools((s) => registerCalendarTools(s, repo, getUserId));

    const response = await tools.get('get_calendar_events')!({});
    const evt = parseToolResponse<{ events: Array<Record<string, unknown>> }>(response).events[0];
    expect(evt.location).toBeNull();
    expect(evt.description).toBeNull();
    expect(evt.calendar_name).toBeNull();
  });

  it('propagates repository errors (no swallowing in this tool)', async () => {
    const repo = makeCalendarRepo({ query: vi.fn(async () => { throw new Error('db down'); }) });
    const tools = captureTools((s) => registerCalendarTools(s, repo, getUserId));

    await expect(tools.get('get_calendar_events')!({})).rejects.toThrow('db down');
  });
});

// ===========================================================================
// ENTITY STATUSES — get_entity_statuses
// ===========================================================================

describe('get_entity_statuses tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes to getByName when entity_name is provided (scoped by user_id)', async () => {
    const getByName = vi.fn(async () => ({
      entityName: 'Alice',
      summary: 'at home',
      location: 'Tel Aviv',
      activity: null,
      source: 'whatsapp',
      timestamp: '2026-04-06T10:00:00Z',
    }));
    const repo = makeEntityStatusRepo({ getByName });
    const tools = captureTools((s) => registerEntityStatusTools(s, repo, getUserId));

    const response = await tools.get('get_entity_statuses')!({ entity_name: 'Alice' });

    expect(getByName).toHaveBeenCalledWith(USER_ID, 'Alice');
    const parsed = parseToolResponse<{ statuses: Array<Record<string, unknown>>; total: number }>(response);
    expect(parsed.total).toBe(1);
    expect(parsed.statuses[0].entity_name).toBe('Alice');
    expect(parsed.statuses[0].status_text).toBe('at home');
    expect(parsed.statuses[0].location).toBe('Tel Aviv');
    expect(parsed.statuses[0].source).toBe('whatsapp');
  });

  it('returns empty result when getByName finds nothing', async () => {
    const repo = makeEntityStatusRepo({ getByName: vi.fn(async () => null) });
    const tools = captureTools((s) => registerEntityStatusTools(s, repo, getUserId));

    const response = await tools.get('get_entity_statuses')!({ entity_name: 'Ghost' });
    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ statuses: unknown[]; total: number }>(response);
    expect(parsed.total).toBe(0);
    expect(parsed.statuses).toEqual([]);
  });

  it('routes to listRecent when entity_name is omitted, forwarding since/limit', async () => {
    const listRecent = vi.fn(async () => [
      { entityName: 'Alice', summary: 'home', location: null, source: 'whatsapp', timestamp: '2026-04-06T10:00:00Z' },
      { entityName: 'Bob',   summary: 'gym',  location: 'Gym',  source: 'telegram', timestamp: '2026-04-06T09:00:00Z' },
    ]);
    const repo = makeEntityStatusRepo({ listRecent });
    const tools = captureTools((s) => registerEntityStatusTools(s, repo, getUserId));

    const response = await tools.get('get_entity_statuses')!({ since: '2026-04-06T00:00:00Z', limit: 5 });

    expect(listRecent).toHaveBeenCalledWith(USER_ID, { since: '2026-04-06T00:00:00Z', limit: 5 });
    const parsed = parseToolResponse<{ statuses: Array<{ entity_name: string }>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.statuses.map((s) => s.entity_name)).toEqual(['Alice', 'Bob']);
  });

  it('preserves null fields on listRecent results', async () => {
    const repo = makeEntityStatusRepo({
      listRecent: vi.fn(async () => [
        { entityName: 'Solo', summary: 'idle', location: undefined, source: undefined, timestamp: '2026-04-06T10:00:00Z' },
      ]),
    });
    const tools = captureTools((s) => registerEntityStatusTools(s, repo, getUserId));

    const response = await tools.get('get_entity_statuses')!({});
    const parsed = parseToolResponse<{ statuses: Array<Record<string, unknown>> }>(response);
    expect(parsed.statuses[0].location).toBeNull();
    expect(parsed.statuses[0].source).toBeNull();
  });

  it('propagates repository errors (no swallowing)', async () => {
    const repo = makeEntityStatusRepo({ listRecent: vi.fn(async () => { throw new Error('es down'); }) });
    const tools = captureTools((s) => registerEntityStatusTools(s, repo, getUserId));

    await expect(tools.get('get_entity_statuses')!({})).rejects.toThrow('es down');
  });
});

// ===========================================================================
// LOCATION TOOLS
// ===========================================================================

describe('get_current_location tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns isError when LocationService reports source=none', async () => {
    const locationRepo = makeLocationRepo();
    const svc = makeLocationService({
      place: null, place_id: null, confidence: 'unknown', source: 'none', reasoning: 'no signal',
    });
    const tools = captureTools((s) => registerLocationTools(s, locationRepo, getUserId, svc));

    const response = await tools.get('get_current_location')!({});
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/No location data available/);
  });

  it('shapes legacy location block from fused.gps when available', async () => {
    const svc = makeLocationService({
      place: 'Home', place_id: 'p-1', confidence: 'high', source: 'gps',
      reasoning: 'GPS fix (60s old) at Home',
      gps: {
        lat: 32.0853, lon: 34.7818,
        accuracy_m: 10, age_s: 60, freshness: 'fresh',
        matched_place: 'Home', address: 'Tel Aviv',
      },
    });
    const tools = captureTools((s) => registerLocationTools(s, makeLocationRepo(), getUserId, svc));

    const response = await tools.get('get_current_location')!({});
    expect(svc.getCurrentLocation).toHaveBeenCalledWith(USER_ID);

    const parsed = parseToolResponse<{ location: Record<string, unknown>; fused: Record<string, unknown> }>(response);
    expect(parsed.location.lat).toBe(32.0853);
    expect(parsed.location.lon).toBe(34.7818);
    expect(parsed.location.accuracy).toBe(10);
    expect(parsed.location.place_name).toBe('Home');
    expect(parsed.location.address).toBe('Tel Aviv');
    expect(parsed.fused.confidence).toBe('high');
    expect(parsed.fused.source).toBe('gps');
  });

  it('returns location:null when source != none but gps is missing (wifi-only)', async () => {
    const svc = makeLocationService({
      place: 'Office', place_id: 'p-2', confidence: 'medium', source: 'wifi',
      reasoning: 'wifi only',
      wifi: { bssid: 'aa:bb:cc:dd:ee:ff', ssid: 'OfficeWifi', connected: true, age_s: 30 },
    });
    const tools = captureTools((s) => registerLocationTools(s, makeLocationRepo(), getUserId, svc));

    const response = await tools.get('get_current_location')!({});
    const parsed = parseToolResponse<{ location: unknown }>(response);
    expect(parsed.location).toBeNull();
  });
});

describe('where_is_user tool handler', () => {
  it('returns the LocationService result verbatim, scoped by user_id', async () => {
    const fused = {
      place: 'Home', place_id: 'p-1', confidence: 'high' as const, source: 'gps' as const, reasoning: 'r',
    };
    const svc = makeLocationService(fused);
    const tools = captureTools((s) => registerLocationTools(s, makeLocationRepo(), getUserId, svc));

    const response = await tools.get('where_is_user')!({});
    expect(svc.getCurrentLocation).toHaveBeenCalledWith(USER_ID);
    expect(parseToolResponse(response)).toEqual(fused);
  });
});

describe('query_location_history tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards from/to/place_id/limit to locationRepo.query scoped by user_id', async () => {
    const query = vi.fn(async () => []);
    const tools = captureTools((s) => registerLocationTools(
      s, makeLocationRepo({ query }), getUserId, makeLocationService({} as never),
    ));

    await tools.get('query_location_history')!({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      place_id: 'place-1',
      limit: 50,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(USER_ID);
    expect(query.mock.calls[0][1]).toEqual({
      startTime: '2026-04-06T00:00:00Z',
      endTime: '2026-04-06T23:59:59Z',
      placeId: 'place-1',
      limit: 50,
    });
  });

  it('defaults limit to 100 when not provided', async () => {
    const query = vi.fn(async () => []);
    const tools = captureTools((s) => registerLocationTools(
      s, makeLocationRepo({ query }), getUserId, makeLocationService({} as never),
    ));

    await tools.get('query_location_history')!({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
    });

    expect(query.mock.calls[0][1].limit).toBe(100);
  });

  it('maps Location[] → response shape with timestamp_local computed via formatTime', async () => {
    const query = vi.fn(async () => [{
      id: 'loc-1',
      userId: USER_ID,
      location: { lat: 32.0853, lon: 34.7818 },
      accuracy: 10,
      timestamp: '2026-04-06T10:00:00Z',
      matchedPlace: 'Home',
      address: 'Tel Aviv',
    } as unknown as Awaited<ReturnType<LocationRepository['query']>>[number]]);

    const tools = captureTools((s) => registerLocationTools(
      s, makeLocationRepo({ query }), getUserId, makeLocationService({} as never),
    ));

    const response = await tools.get('query_location_history')!({
      from: '2026-04-06T00:00:00Z', to: '2026-04-06T23:59:59Z',
    });

    const parsed = parseToolResponse<{ locations: Array<Record<string, unknown>>; total: number; tz: string }>(response);
    expect(parsed.total).toBe(1);
    expect(parsed.locations[0].id).toBe('loc-1');
    expect(parsed.locations[0].lat).toBe(32.0853);
    expect(parsed.locations[0].timestamp_local).toBe('local-stub');
    expect(parsed.locations[0].place_name).toBe('Home');
    expect(parsed.locations[0].address).toBe('Tel Aviv');
  });
});

describe('delete_location_point tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls repo.delete with userId/id and emits an audit log on success', async () => {
    const del = vi.fn(async () => true);
    const tools = captureTools((s) => registerLocationTools(
      s, makeLocationRepo({ delete: del }), getUserId, makeLocationService({} as never),
    ));

    const response = await tools.get('delete_location_point')!({ id: 'loc-1', reason: 'indoor drift' });

    expect(del).toHaveBeenCalledWith(USER_ID, 'loc-1');
    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ deleted: boolean; id: string; reason: string }>(response);
    expect(parsed.deleted).toBe(true);
    expect(parsed.id).toBe('loc-1');
    expect(parsed.reason).toBe('indoor drift');

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'awareness',
      action: 'delete',
      entity_type: 'location',
      entity_id: 'loc-1',
      metadata: { reason: 'indoor drift' },
    }));
  });

  it('returns isError when delete returns false (not found)', async () => {
    const del = vi.fn(async () => false);
    const tools = captureTools((s) => registerLocationTools(
      s, makeLocationRepo({ delete: del }), getUserId, makeLocationService({} as never),
    ));

    const response = await tools.get('delete_location_point')!({ id: 'loc-missing' });
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/not found|deleted/i);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// MEDIA TOOLS
// ===========================================================================

describe('upload_media tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('indexes a media doc scoped to user_id and returns media_id', async () => {
    const es = makeMockEsClient({
      index: vi.fn().mockResolvedValue({ _id: 'media-1', result: 'created' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    const response = await tools.get('upload_media')!({
      url: 'https://example/x.jpg',
      mime_type: 'image/jpeg',
      filename: 'x.jpg',
      description: 'a photo',
      source: 'chat',
      tags: ['cat'],
    });

    const call = (es.index as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_media');
    expect(call.refresh).toBe('wait_for');
    expect(call.document).toMatchObject({
      user_id: USER_ID,
      url: 'https://example/x.jpg',
      mime_type: 'image/jpeg',
      filename: 'x.jpg',
      description: 'a photo',
      source: 'chat',
      tags: ['cat'],
    });

    expect(parseToolResponse<{ media_id: string; url: string }>(response)).toEqual({
      media_id: 'media-1', url: 'https://example/x.jpg',
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create', entity_type: 'media', entity_id: 'media-1', user_id: USER_ID,
    }));
  });

  it('coerces optional filename/description/source/tags to null/[] defaults', async () => {
    const es = makeMockEsClient({
      index: vi.fn().mockResolvedValue({ _id: 'm-2', result: 'created' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    await tools.get('upload_media')!({ url: 'u', mime_type: 'text/plain' });

    const doc = (es.index as ReturnType<typeof vi.fn>).mock.calls[0][0].document;
    expect(doc.filename).toBeNull();
    expect(doc.description).toBeNull();
    expect(doc.source).toBeNull();
    expect(doc.tags).toEqual([]);
  });
});

describe('list_media tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('searches ll5_media scoped to user_id with multi_match + source/tag/mime/since filters', async () => {
    const es = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: { hits: [{ _id: 'm-1', _source: { url: 'u', filename: 'a.jpg' } }], total: { value: 1 } },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    const response = await tools.get('list_media')!({
      query: 'beach', source: 'chat', tags: ['vacation', 'family'],
      mime_type: 'image/jpeg', since: '2026-04-01T00:00:00Z', limit: 5, offset: 10,
    });

    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_media');
    expect(call.size).toBe(5);
    expect(call.from).toBe(10);
    const must = call.query.bool.must as Array<Record<string, unknown>>;
    // user_id is always first
    expect(must[0]).toEqual({ term: { user_id: USER_ID } });
    expect(must).toEqual(expect.arrayContaining([
      { multi_match: { query: 'beach', fields: ['filename', 'description'] } },
      { term: { source: 'chat' } },
      { term: { tags: 'vacation' } },
      { term: { tags: 'family' } },
      { term: { mime_type: 'image/jpeg' } },
      { range: { created_at: { gte: '2026-04-01T00:00:00Z' } } },
    ]));

    const parsed = parseToolResponse<{ media: Array<{ id: string }>; total: number }>(response);
    expect(parsed.total).toBe(1);
    expect(parsed.media[0].id).toBe('m-1');
  });

  it('uses size=20 and offset=0 defaults', async () => {
    const es = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [], total: { value: 0 } } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    await tools.get('list_media')!({});

    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.size).toBe(20);
    expect(call.from).toBe(0);
    // Only the user_id term is in must
    expect(call.query.bool.must).toEqual([{ term: { user_id: USER_ID } }]);
  });
});

describe('link_media / unlink_media tool handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('link_media writes a deterministic ID and audit log', async () => {
    const es = makeMockEsClient({
      get: vi.fn().mockResolvedValue({ _id: 'm-1', _source: { user_id: USER_ID } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    const response = await tools.get('link_media')!({
      media_id: 'm-1', entity_type: 'person', entity_id: 'p-7',
    });

    const call = (es.index as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_media_links');
    expect(call.id).toBe('m-1_person_p-7');
    expect(call.document).toMatchObject({
      user_id: USER_ID, media_id: 'm-1', entity_type: 'person', entity_id: 'p-7',
    });
    expect(parseToolResponse<{ linked: boolean }>(response).linked).toBe(true);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create', entity_type: 'media_link', entity_id: 'm-1_person_p-7',
    }));
  });

  it('unlink_media deletes by the deterministic ID scoped to user_id', async () => {
    const delByQuery = vi.fn().mockResolvedValue({ deleted: 1 });
    const es = makeMockEsClient({ deleteByQuery: delByQuery });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    await tools.get('unlink_media')!({ media_id: 'm-1', entity_type: 'person', entity_id: 'p-7' });

    const arg = delByQuery.mock.calls[0][0];
    expect(arg.index).toBe('ll5_media_links');
    const body = JSON.stringify(arg.query);
    expect(body).toContain(USER_ID);
    expect(body).toContain('m-1_person_p-7');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete', entity_type: 'media_link',
    }));
  });
});

describe('get_media_for tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty media array when no links exist for the entity', async () => {
    const es = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [], total: { value: 0 } } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    const response = await tools.get('get_media_for')!({ entity_type: 'person', entity_id: 'p-7' });

    expect(parseToolResponse<{ media: unknown[] }>(response).media).toEqual([]);
    expect(es.search).toHaveBeenCalledTimes(1);
    // First call queries ll5_media_links scoped by user_id + entity_type + entity_id
    const linkCall = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(linkCall.index).toBe('ll5_media_links');
    expect(linkCall.query.bool.must).toEqual([
      { term: { user_id: USER_ID } },
      { term: { entity_type: 'person' } },
      { term: { entity_id: 'p-7' } },
    ]);
  });

  it('fetches matched media records when links exist, scoped by user_id', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce({
        hits: { hits: [
          { _id: 'link-1', _source: { media_id: 'm-1' } },
          { _id: 'link-2', _source: { media_id: 'm-2' } },
        ], total: { value: 2 } },
      })
      .mockResolvedValueOnce({
        hits: { hits: [
          { _id: 'm-1', _source: { url: 'u1', user_id: USER_ID } },
          { _id: 'm-2', _source: { url: 'u2', user_id: USER_ID } },
        ], total: { value: 2 } },
      });
    const es = makeMockEsClient({ search });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    const response = await tools.get('get_media_for')!({ entity_type: 'action', entity_id: 'a-1' });

    expect(search).toHaveBeenCalledTimes(2);
    const mediaCall = search.mock.calls[1][0];
    expect(mediaCall.index).toBe('ll5_media');
    expect(mediaCall.query.bool.must).toEqual([{ term: { user_id: USER_ID } }]);
    expect(mediaCall.query.bool.filter).toEqual([{ ids: { values: ['m-1', 'm-2'] } }]);

    const parsed = parseToolResponse<{ media: Array<{ id: string }> }>(response);
    expect(parsed.media.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  });
});

describe('delete_media tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('verifies ownership then deletes links + media + audits', async () => {
    const es = makeMockEsClient({
      get: vi.fn().mockResolvedValue({ _id: 'm-1', _source: { user_id: USER_ID, url: 'u' } }),
      deleteByQuery: vi.fn().mockResolvedValue({ deleted: 2 }),
      delete: vi.fn().mockResolvedValue({ result: 'deleted' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    const response = await tools.get('delete_media')!({ media_id: 'm-1' });

    expect(es.get).toHaveBeenCalledWith({ index: 'll5_media', id: 'm-1' });
    const dbqArg = (es.deleteByQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(dbqArg.index).toBe('ll5_media_links');
    const dbqBody = JSON.stringify(dbqArg.query);
    expect(dbqBody).toContain(USER_ID);
    expect(dbqBody).toContain('m-1');
    expect(es.delete).toHaveBeenCalledWith({ index: 'll5_media', id: 'm-1' });
    expect(parseToolResponse<{ deleted: boolean; id: string }>(response)).toEqual({ deleted: true, id: 'm-1' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete', entity_type: 'media', entity_id: 'm-1',
    }));
  });

  it('refuses to delete media owned by another user', async () => {
    const del = vi.fn();
    const delByQuery = vi.fn();
    const es = makeMockEsClient({
      get: vi.fn().mockResolvedValue({ _id: 'm-1', _source: { user_id: 'someone-else' } }),
      delete: del,
      deleteByQuery: delByQuery,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    const response = await tools.get('delete_media')!({ media_id: 'm-1' });
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/Not found/);
    expect(del).not.toHaveBeenCalled();
    expect(delByQuery).not.toHaveBeenCalled();
  });

  it('returns isError when media does not exist', async () => {
    const es = makeMockEsClient({
      get: vi.fn().mockRejectedValue(new Error('not found')),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = captureTools((s) => registerMediaTools(s, es as any, getUserId));

    const response = await tools.get('delete_media')!({ media_id: 'm-1' });
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/Media not found/);
  });
});

// ===========================================================================
// NOTABLE EVENTS — get_notable_events, acknowledge_events
// ===========================================================================

describe('get_notable_events tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards since/event_type/min_severity to repo.queryUnacknowledged scoped by user_id', async () => {
    const query = vi.fn(async () => []);
    const tools = captureTools((s) => registerNotableEventTools(s, makeNotableRepo({ queryUnacknowledged: query }), getUserId));

    await tools.get('get_notable_events')!({
      since: '2026-04-06T00:00:00Z',
      event_type: 'urgent_im',
      min_severity: 'medium',
    });

    expect(query).toHaveBeenCalledWith(USER_ID, {
      since: '2026-04-06T00:00:00Z',
      event_type: 'urgent_im',
      min_severity: 'medium',
    });
  });

  it('shapes events to API response with severity pulled from details, defaulting to low', async () => {
    const query = vi.fn(async () => [
      { id: 'n1', userId: USER_ID, type: 'location_change', summary: 'Arrived', details: { severity: 'high', extra: 1 }, acknowledged: false, timestamp: '2026-04-06T10:00:00Z' },
      { id: 'n2', userId: USER_ID, type: 'calendar_upcoming', summary: 'Meeting', details: {}, acknowledged: false, timestamp: '2026-04-06T09:00:00Z' },
    ]);
    const tools = captureTools((s) => registerNotableEventTools(
      s, makeNotableRepo({ queryUnacknowledged: query }), getUserId,
    ));

    const response = await tools.get('get_notable_events')!({});
    const parsed = parseToolResponse<{ events: Array<Record<string, unknown>>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.events[0]).toMatchObject({
      id: 'n1', event_type: 'location_change', severity: 'high',
    });
    expect((parsed.events[0].payload as Record<string, unknown>).extra).toBe(1);
    expect(parsed.events[1].severity).toBe('low');
  });

  it('returns empty list when nothing is unacknowledged', async () => {
    const tools = captureTools((s) => registerNotableEventTools(
      s, makeNotableRepo({ queryUnacknowledged: vi.fn(async () => []) }), getUserId,
    ));

    const response = await tools.get('get_notable_events')!({});
    const parsed = parseToolResponse<{ events: unknown[]; total: number }>(response);
    expect(parsed.total).toBe(0);
  });

  it('acknowledged_at is always null — queryUnacknowledged contract guarantees acknowledged=false', async () => {
    // Even if the repo somehow returns acknowledged=true (contract violation),
    // the tool collapses to null because the contract of queryUnacknowledged
    // is that everything returned is by definition unacknowledged. This locks
    // in the post-2026-05-18 dead-branch removal.
    const query = vi.fn(async () => [
      { id: 'n-ack', userId: USER_ID, type: 'urgent_im', summary: 'X', details: {}, acknowledged: true, timestamp: '2026-04-06T10:00:00Z' },
    ]);
    const tools = captureTools((s) => registerNotableEventTools(
      s, makeNotableRepo({ queryUnacknowledged: query }), getUserId,
    ));
    const response = await tools.get('get_notable_events')!({});
    const parsed = parseToolResponse<{ events: Array<{ acknowledged_at: string | null }> }>(response);
    expect(parsed.events[0].acknowledged_at).toBeNull();
  });
});

describe('acknowledge_events tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards event_ids to repo.acknowledge scoped by user_id and returns acknowledged_count', async () => {
    const ack = vi.fn(async () => 3);
    const tools = captureTools((s) => registerNotableEventTools(
      s, makeNotableRepo({ acknowledge: ack }), getUserId,
    ));

    const response = await tools.get('acknowledge_events')!({ event_ids: ['n1', 'n2', 'n3'] });

    expect(ack).toHaveBeenCalledWith(USER_ID, ['n1', 'n2', 'n3']);
    expect(parseToolResponse<{ acknowledged_count: number }>(response).acknowledged_count).toBe(3);
  });

  it('returns 0 for an empty event_ids list', async () => {
    const ack = vi.fn(async () => 0);
    const tools = captureTools((s) => registerNotableEventTools(
      s, makeNotableRepo({ acknowledge: ack }), getUserId,
    ));

    const response = await tools.get('acknowledge_events')!({ event_ids: [] });
    expect(ack).toHaveBeenCalledWith(USER_ID, []);
    expect(parseToolResponse<{ acknowledged_count: number }>(response).acknowledged_count).toBe(0);
  });
});

// ===========================================================================
// PHONE STATUS — get_phone_status, get_phone_status_history
// ===========================================================================

describe('get_phone_status tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns isError when no phone status exists', async () => {
    const tools = captureTools((s) => registerPhoneStatusTools(
      s, makePhoneStatusRepo({ getLatest: vi.fn(async () => null) }), getUserId,
    ));

    const response = await tools.get('get_phone_status')!({});
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/No phone status data available/);
  });

  it('shapes phone status snapshot with computed age_minutes', async () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    const tools = captureTools((s) => registerPhoneStatusTools(
      s, makePhoneStatusRepo({
        getLatest: vi.fn(async () => ({
          id: 'ps-1', userId: USER_ID,
          batteryPct: 73, isCharging: true,
          plugType: 'usb', batteryTempC: 32.1, batteryHealth: 'good',
          lowPowerMode: false,
          storageUsedBytes: 50_000_000_000, storageTotalBytes: 128_000_000_000,
          ramUsedBytes: 6_000_000_000, ramTotalBytes: 8_000_000_000,
          trigger: 'periodic',
          timestamp: ts,
        })),
      }), getUserId,
    ));

    const response = await tools.get('get_phone_status')!({});
    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ phone_status: Record<string, unknown> }>(response);
    expect(parsed.phone_status.id).toBe('ps-1');
    expect(parsed.phone_status.battery_pct).toBe(73);
    expect(parsed.phone_status.is_charging).toBe(true);
    expect(parsed.phone_status.plug_type).toBe('usb');
    expect(parsed.phone_status.battery_temp_c).toBe(32.1);
    expect(parsed.phone_status.battery_health).toBe('good');
    expect(parsed.phone_status.storage_used_bytes).toBe(50_000_000_000);
    expect(parsed.phone_status.age_minutes).toBeGreaterThanOrEqual(4);
    expect(parsed.phone_status.age_minutes).toBeLessThanOrEqual(6);
  });

  it('coerces missing optional fields to null', async () => {
    const ts = new Date().toISOString();
    const tools = captureTools((s) => registerPhoneStatusTools(
      s, makePhoneStatusRepo({
        getLatest: vi.fn(async () => ({
          id: 'ps-2', userId: USER_ID, batteryPct: 50, isCharging: false, timestamp: ts,
        })),
      }), getUserId,
    ));

    const response = await tools.get('get_phone_status')!({});
    const ps = parseToolResponse<{ phone_status: Record<string, unknown> }>(response).phone_status;
    expect(ps.plug_type).toBeNull();
    expect(ps.battery_temp_c).toBeNull();
    expect(ps.low_power_mode).toBeNull();
  });

  it('scopes repo.getLatest by user_id', async () => {
    const getLatest = vi.fn(async () => null);
    const tools = captureTools((s) => registerPhoneStatusTools(s, makePhoneStatusRepo({ getLatest }), getUserId));

    await tools.get('get_phone_status')!({});
    expect(getLatest).toHaveBeenCalledWith(USER_ID);
  });
});

describe('get_phone_status_history tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards from/to/limit to repo.query scoped by user_id, defaults limit to 100', async () => {
    const query = vi.fn(async () => []);
    const tools = captureTools((s) => registerPhoneStatusTools(s, makePhoneStatusRepo({ query }), getUserId));

    await tools.get('get_phone_status_history')!({
      from: '2026-04-06T00:00:00Z', to: '2026-04-06T23:59:59Z',
    });

    expect(query).toHaveBeenCalledWith(USER_ID, {
      startTime: '2026-04-06T00:00:00Z',
      endTime: '2026-04-06T23:59:59Z',
      limit: 100,
    });
  });

  it('maps PhoneStatus[] to the response envelope', async () => {
    const ts = '2026-04-06T10:00:00Z';
    const query = vi.fn(async () => [
      { id: 'ps-1', userId: USER_ID, batteryPct: 80, isCharging: true, plugType: 'usb', timestamp: ts },
      { id: 'ps-2', userId: USER_ID, batteryPct: 79, isCharging: false, timestamp: ts },
    ]);
    const tools = captureTools((s) => registerPhoneStatusTools(s, makePhoneStatusRepo({ query }), getUserId));

    const response = await tools.get('get_phone_status_history')!({
      from: '2026-04-06T00:00:00Z', to: '2026-04-06T23:59:59Z', limit: 10,
    });

    const parsed = parseToolResponse<{ phone_statuses: Array<Record<string, unknown>>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.phone_statuses[0].id).toBe('ps-1');
    expect(parsed.phone_statuses[0].plug_type).toBe('usb');
    expect(parsed.phone_statuses[1].plug_type).toBeNull();
  });
});

// ===========================================================================
// WIFI — get_current_wifi, get_wifi_history
// ===========================================================================

describe('get_current_wifi tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns isError when no wifi data exists', async () => {
    const tools = captureTools((s) => registerWifiTools(
      s, makeWifiRepo({ getLatest: vi.fn(async () => null) }), getUserId,
    ));

    const response = await tools.get('get_current_wifi')!({});
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/No wifi data available/);
  });

  it('shapes wifi snapshot and computes age_minutes', async () => {
    const ts = new Date(Date.now() - 2 * 60_000).toISOString();
    const tools = captureTools((s) => registerWifiTools(
      s, makeWifiRepo({
        getLatest: vi.fn(async () => ({
          id: 'w-1', userId: USER_ID,
          connected: true, ssid: 'Home', bssid: 'aa:bb:cc:dd:ee:ff',
          rssiDbm: -55, frequencyMhz: 5180, linkSpeedMbps: 866,
          ipAddress: '192.168.1.7', trigger: 'connect',
          timestamp: ts,
        })),
      }), getUserId,
    ));

    const response = await tools.get('get_current_wifi')!({});
    const wifi = parseToolResponse<{ wifi: Record<string, unknown> }>(response).wifi;
    expect(wifi.ssid).toBe('Home');
    expect(wifi.bssid).toBe('aa:bb:cc:dd:ee:ff');
    expect(wifi.rssi_dbm).toBe(-55);
    expect(wifi.frequency_mhz).toBe(5180);
    expect(wifi.ip_address).toBe('192.168.1.7');
    expect(wifi.age_minutes).toBeGreaterThanOrEqual(1);
    expect(wifi.age_minutes).toBeLessThanOrEqual(3);
  });

  it('preserves disconnected snapshots (connected=false)', async () => {
    const ts = new Date().toISOString();
    const tools = captureTools((s) => registerWifiTools(
      s, makeWifiRepo({
        getLatest: vi.fn(async () => ({
          id: 'w-d', userId: USER_ID, connected: false, ssid: null, bssid: null, timestamp: ts,
        })),
      }), getUserId,
    ));

    const response = await tools.get('get_current_wifi')!({});
    const wifi = parseToolResponse<{ wifi: Record<string, unknown> }>(response).wifi;
    expect(wifi.connected).toBe(false);
    expect(wifi.ssid).toBeNull();
    expect(wifi.bssid).toBeNull();
  });
});

describe('get_wifi_history tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards from/to/ssid/bssid/limit (defaulting to 100) scoped by user_id', async () => {
    const query = vi.fn(async () => []);
    const tools = captureTools((s) => registerWifiTools(s, makeWifiRepo({ query }), getUserId));

    await tools.get('get_wifi_history')!({
      from: '2026-04-06T00:00:00Z', to: '2026-04-06T23:59:59Z',
      ssid: 'Home', bssid: 'aa:bb:cc:dd:ee:ff',
    });

    expect(query).toHaveBeenCalledWith(USER_ID, {
      startTime: '2026-04-06T00:00:00Z',
      endTime: '2026-04-06T23:59:59Z',
      ssid: 'Home',
      bssid: 'aa:bb:cc:dd:ee:ff',
      limit: 100,
    });
  });

  it('maps WifiConnection[] to the response envelope (selected fields only)', async () => {
    const ts = '2026-04-06T10:00:00Z';
    const query = vi.fn(async () => [
      { id: 'w-1', userId: USER_ID, connected: true,  ssid: 'Home', bssid: 'a',  rssiDbm: -50, trigger: 'connect',    timestamp: ts },
      { id: 'w-2', userId: USER_ID, connected: false, ssid: null,   bssid: null,                trigger: 'disconnect', timestamp: ts },
    ]);
    const tools = captureTools((s) => registerWifiTools(s, makeWifiRepo({ query }), getUserId));

    const response = await tools.get('get_wifi_history')!({ from: 'a', to: 'b' });

    const parsed = parseToolResponse<{ wifi_events: Array<Record<string, unknown>>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.wifi_events[0].ssid).toBe('Home');
    expect(parsed.wifi_events[0].connected).toBe(true);
    expect(parsed.wifi_events[1].ssid).toBeNull();
    expect(parsed.wifi_events[1].rssi_dbm).toBeNull();
  });
});
