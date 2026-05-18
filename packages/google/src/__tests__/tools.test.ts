import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CalendarConfigRepository, CalendarConfigRecord, CalendarAccessMode } from '../repositories/interfaces/calendar-config.repository.js';
import type { UserSettingsRepository } from '../repositories/interfaces/user-settings.repository.js';
import type { OAuthTokenRepository, OAuthTokenRecord } from '../repositories/interfaces/oauth-token.repository.js';
import type { ESCalendarEventRepository, CalendarEventDoc } from '../repositories/elasticsearch/calendar-event.repository.js';
import type { GoogleClientConfig } from '../utils/google-client.js';
import { captureTools, parseToolResponse } from './_helpers.js';

// ---------------------------------------------------------------------------
// Mock: @ll5/shared
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
  generateToken: vi.fn().mockReturnValue('mock-gw-token'),
  sessionTimezone: vi.fn().mockReturnValue('Asia/Jerusalem'),
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock: googleapis — intercept all Google API calls at the external boundary.
// The mock is shared across all tests; individual tests configure return values.
// ---------------------------------------------------------------------------
const mockEventsInsert = vi.fn();
const mockEventsGet = vi.fn();
const mockEventsList = vi.fn();
const mockEventsPatch = vi.fn();
const mockEventsDelete = vi.fn();
const mockCalendarListList = vi.fn();
const mockFreebusyQuery = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    calendar: () => ({
      events: {
        insert: mockEventsInsert,
        get: mockEventsGet,
        list: mockEventsList,
        patch: mockEventsPatch,
        delete: mockEventsDelete,
      },
      calendarList: { list: mockCalendarListList },
      freebusy: { query: mockFreebusyQuery },
    }),
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
        generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock'),
        getToken: vi.fn(),
        revokeToken: vi.fn(),
        refreshAccessToken: vi.fn(),
      })),
    },
    oauth2: vi.fn().mockReturnValue({
      userinfo: { get: vi.fn().mockResolvedValue({ data: { email: 'test@example.com' } }) },
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock: google-client utility (OAuth wiring is not under test here)
// ---------------------------------------------------------------------------
vi.mock('../utils/google-client.js', () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({
    setCredentials: vi.fn(),
  }),
  createOAuth2Client: vi.fn().mockReturnValue({
    setCredentials: vi.fn(),
    generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock'),
    getToken: vi.fn(),
    revokeToken: vi.fn(),
  }),
  expandScopes: vi.fn().mockImplementation((s?: string[]) => s ?? ['calendar.readonly']),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'test-user-google-1234';
const getUserId = () => USER_ID;

const GOOGLE_CONFIG: GoogleClientConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.com/oauth/callback',
};

function makeCalendarConfig(overrides: Partial<CalendarConfigRecord> = {}): CalendarConfigRecord {
  return {
    user_id: USER_ID,
    calendar_id: 'primary',
    calendar_name: 'My Calendar',
    enabled: true,
    color: '#4285f4',
    role: 'user',
    access_mode: 'read' as CalendarAccessMode,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeTokenRecord(): OAuthTokenRecord {
  return {
    user_id: USER_ID,
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_type: 'Bearer',
    expires_at: new Date(Date.now() + 3600_000),
    scopes: ['calendar.readonly', 'calendar.events'],
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeCalendarEventDoc(overrides: Partial<CalendarEventDoc> = {}): CalendarEventDoc {
  return {
    user_id: USER_ID,
    title: 'Test Event',
    start_time: '2026-04-06T10:00:00Z',
    end_time: '2026-04-06T11:00:00Z',
    all_day: false,
    source: 'google',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTokenRepo(overrides: Partial<OAuthTokenRepository> = {}): OAuthTokenRepository {
  return {
    store: vi.fn(),
    get: vi.fn().mockResolvedValue(makeTokenRecord()),
    updateAccessToken: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

function makeCalendarConfigRepo(overrides: Partial<CalendarConfigRepository> = {}): CalendarConfigRepository {
  return {
    upsert: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    getByRole: vi.fn().mockResolvedValue(null),
    setAccessMode: vi.fn(),
    getReadableCalendarIds: vi.fn().mockResolvedValue(['primary']),
    getWritableCalendarIds: vi.fn().mockResolvedValue(['primary']),
    deleteAll: vi.fn(),
    ...overrides,
  };
}

function makeUserSettingsRepo(overrides: Partial<UserSettingsRepository> = {}): UserSettingsRepository {
  return {
    get: vi.fn().mockResolvedValue({ user_id: USER_ID, timezone: 'Asia/Jerusalem' }),
    setTimezone: vi.fn(),
    ...overrides,
  };
}

function makeESCalendarRepo(overrides: Partial<ESCalendarEventRepository> = {}): ESCalendarEventRepository {
  return {
    query: vi.fn().mockResolvedValue([]),
    upsertFromGoogle: vi.fn(),
    deleteByDocId: vi.fn(),
    ...overrides,
  } as unknown as ESCalendarEventRepository;
}

// ===========================================================================
// list_events — reads from ES, forwards user_id to the ES repo
// ===========================================================================

describe('list_events tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads events from ES with USER_ID scoping and returns them in the envelope', async () => {
    const docs = [
      makeCalendarEventDoc({ title: 'Meeting A', google_event_id: 'evt-1', calendar_id: 'primary', calendar_name: 'Primary' }),
      makeCalendarEventDoc({ title: 'Meeting B', google_event_id: 'evt-2', calendar_id: 'primary', calendar_name: 'Primary' }),
    ];
    const query = vi.fn(async () => docs);
    const esRepo = makeESCalendarRepo({ query });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), makeUserSettingsRepo(), esRepo, GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('list_events')!({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
    });

    // Multi-tenancy: ES query MUST be scoped to USER_ID
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(USER_ID);

    const parsed = parseToolResponse<Array<{ title: string }>>(response);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe('Meeting A');
    expect(parsed[1].title).toBe('Meeting B');
  });

  it('passes date range and calendar IDs to ES query (scoped to USER_ID)', async () => {
    const query = vi.fn(async () => []);
    const esRepo = makeESCalendarRepo({ query });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), makeUserSettingsRepo(), esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('list_events')!({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      calendar_id: 'cal-specific',
    });

    expect(query).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      calendarIds: ['cal-specific'],
      isTickler: false,
    }));
  });

  it('uses user timezone (from settings repo, scoped to USER_ID) for default date range', async () => {
    const query = vi.fn(async () => []);
    const esRepo = makeESCalendarRepo({ query });
    const settingsGet = vi.fn(async () => ({ user_id: USER_ID, timezone: 'Asia/Jerusalem' }));
    const userSettingsRepo = makeUserSettingsRepo({ get: settingsGet });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), userSettingsRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('list_events')!({});

    expect(settingsGet).toHaveBeenCalledWith(USER_ID);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(USER_ID);
  });

  it('passes max_results as limit to the ES query', async () => {
    const query = vi.fn(async () => []);
    const esRepo = makeESCalendarRepo({ query });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), makeUserSettingsRepo(), esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('list_events')!({ max_results: 10 });

    expect(query).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ limit: 10 }));
  });

  it('passes query for text search to the ES query', async () => {
    const query = vi.fn(async () => []);
    const esRepo = makeESCalendarRepo({ query });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), makeUserSettingsRepo(), esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('list_events')!({ query: 'standup' });

    expect(query).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ query: 'standup' }));
  });
});

// ===========================================================================
// create_event — writes to Google API + ES, scoped to user_id
// ===========================================================================

describe('create_event tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an event via Google API and writes through to ES under USER_ID', async () => {
    mockEventsInsert.mockResolvedValue({
      data: {
        id: 'new-evt-1',
        htmlLink: 'https://calendar.google.com/event/new-evt-1',
        status: 'confirmed',
        start: { dateTime: '2026-04-06T10:00:00+03:00' },
        end: { dateTime: '2026-04-06T11:00:00+03:00' },
      },
    });
    const upsertFromGoogle = vi.fn();
    const esRepo = makeESCalendarRepo({ upsertFromGoogle });
    const calendarConfigRepo = makeCalendarConfigRepo({
      list: vi.fn().mockResolvedValue([makeCalendarConfig()]),
    });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), calendarConfigRepo, makeUserSettingsRepo(), esRepo, GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('create_event')!({
      title: 'Team Standup',
      start: '2026-04-06T10:00:00+03:00',
      end: '2026-04-06T11:00:00+03:00',
    });

    // Real Google API mock was called by the real handler
    expect(mockEventsInsert).toHaveBeenCalledTimes(1);
    const insertArg = mockEventsInsert.mock.calls[0][0];
    expect(insertArg.calendarId).toBe('primary');
    expect((insertArg.requestBody as { summary: string }).summary).toBe('Team Standup');

    // Multi-tenancy: ES upsert MUST be scoped to USER_ID
    expect(upsertFromGoogle).toHaveBeenCalledTimes(1);
    expect(upsertFromGoogle.mock.calls[0][0]).toBe(USER_ID);

    const parsed = parseToolResponse<{ event_id: string; status: string }>(response);
    expect(parsed.event_id).toBe('new-evt-1');
    expect(parsed.status).toBe('confirmed');
  });

  it('writes through to ES with the created event data (scoped to USER_ID)', async () => {
    mockEventsInsert.mockResolvedValue({
      data: {
        id: 'evt-es',
        htmlLink: '',
        status: 'confirmed',
        start: { dateTime: '2026-04-06T10:00:00Z' },
        end: { dateTime: '2026-04-06T11:00:00Z' },
      },
    });
    const upsertFromGoogle = vi.fn();
    const esRepo = makeESCalendarRepo({ upsertFromGoogle });
    const calendarConfigRepo = makeCalendarConfigRepo({
      list: vi.fn().mockResolvedValue([makeCalendarConfig()]),
    });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), calendarConfigRepo, makeUserSettingsRepo(), esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('create_event')!({
      title: 'ES Write Test',
      start: '2026-04-06T10:00:00Z',
      end: '2026-04-06T11:00:00Z',
    });

    expect(upsertFromGoogle).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ event_id: 'evt-es', title: 'ES Write Test' }),
    );
  });

  it('rejects non-primary calendar without readwrite access (scoped to USER_ID), does NOT call Google API', async () => {
    const getWritableCalendarIds = vi.fn(async () => []);
    const calendarConfigRepo = makeCalendarConfigRepo({ getWritableCalendarIds });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), calendarConfigRepo, makeUserSettingsRepo(), makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('create_event')!({
      calendar_id: 'readonly-cal',
      title: 'Test',
      start: '2026-04-06T10:00:00Z',
      end: '2026-04-06T11:00:00Z',
    });

    expect(getWritableCalendarIds).toHaveBeenCalledWith(USER_ID);
    expect(mockEventsInsert).not.toHaveBeenCalled();
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toContain('not configured for readwrite');
  });

  it('handles all-day events with date-only start/end via Google API', async () => {
    mockEventsInsert.mockResolvedValue({
      data: {
        id: 'allday-evt',
        htmlLink: '',
        status: 'confirmed',
        start: { date: '2026-04-06' },
        end: { date: '2026-04-07' },
      },
    });
    const upsertFromGoogle = vi.fn();
    const esRepo = makeESCalendarRepo({ upsertFromGoogle });
    const calendarConfigRepo = makeCalendarConfigRepo({
      list: vi.fn().mockResolvedValue([makeCalendarConfig()]),
    });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), calendarConfigRepo, makeUserSettingsRepo(), esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('create_event')!({
      title: 'All Day Off',
      start: '2026-04-06',
      end: '2026-04-07',
      all_day: true,
    });

    expect(mockEventsInsert).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({
        start: { date: '2026-04-06' },
        end: { date: '2026-04-07' },
      }),
    }));
    // Multi-tenancy: ES write is scoped to USER_ID
    expect(upsertFromGoogle.mock.calls[0][0]).toBe(USER_ID);
  });
});

// ===========================================================================
// configure_calendar — direct repo write, scoped to user_id
// ===========================================================================

describe('configure_calendar tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards USER_ID, calendar_id, and access_mode=ignore to the config repo', async () => {
    const setAccessMode = vi.fn(async () => undefined);
    const calendarConfigRepo = makeCalendarConfigRepo({ setAccessMode });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), calendarConfigRepo, makeUserSettingsRepo(), makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('configure_calendar')!({
      calendar_id: 'cal-1',
      access_mode: 'ignore',
    });

    expect(setAccessMode).toHaveBeenCalledWith(USER_ID, 'cal-1', 'ignore');
    const parsed = parseToolResponse<{ updated: boolean; access_mode: string }>(response);
    expect(parsed.updated).toBe(true);
    expect(parsed.access_mode).toBe('ignore');
  });

  it('forwards access_mode=readwrite scoped to USER_ID', async () => {
    const setAccessMode = vi.fn(async () => undefined);
    const calendarConfigRepo = makeCalendarConfigRepo({ setAccessMode });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), calendarConfigRepo, makeUserSettingsRepo(), makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    await tools.get('configure_calendar')!({
      calendar_id: 'cal-2',
      access_mode: 'readwrite',
    });

    expect(setAccessMode).toHaveBeenCalledWith(USER_ID, 'cal-2', 'readwrite');
  });

  it('forwards access_mode=read scoped to USER_ID', async () => {
    const setAccessMode = vi.fn(async () => undefined);
    const calendarConfigRepo = makeCalendarConfigRepo({ setAccessMode });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), calendarConfigRepo, makeUserSettingsRepo(), makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    await tools.get('configure_calendar')!({
      calendar_id: 'cal-3',
      access_mode: 'read',
    });

    expect(setAccessMode).toHaveBeenCalledWith(USER_ID, 'cal-3', 'read');
  });
});

// ===========================================================================
// Tickler Tools
// ===========================================================================

describe('create_tickler tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupTickler() {
    const calendarConfigRepo = makeCalendarConfigRepo({
      getByRole: vi.fn().mockResolvedValue(
        makeCalendarConfig({ calendar_id: 'tickler-cal-id', calendar_name: 'LL5 System', role: 'tickler' }),
      ),
    });
    const upsertFromGoogle = vi.fn();
    const esRepo = makeESCalendarRepo({ upsertFromGoogle });
    return { calendarConfigRepo, esRepo, upsertFromGoogle };
  }

  it('creates a timed tickler with due_date and due_time (scoped to USER_ID)', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-1', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-10T08:00:00' }, end: { dateTime: '2026-04-10T08:30:00' } },
    });
    const { calendarConfigRepo, esRepo, upsertFromGoogle } = setupTickler();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('create_tickler')!({
      title: 'Check insurance',
      due_date: '2026-04-10',
      due_time: '09:00',
    });

    expect(mockEventsInsert).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'tickler-cal-id',
    }));
    // Multi-tenancy: ES write under USER_ID
    expect(upsertFromGoogle.mock.calls[0][0]).toBe(USER_ID);
    const parsed = parseToolResponse<{ title: string; due_date: string }>(response);
    expect(parsed.title).toBe('Check insurance');
    expect(parsed.due_date).toBe('2026-04-10');
  });

  it('creates an all-day tickler when due_time is "all_day"', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-allday', htmlLink: '', status: 'confirmed', start: { date: '2026-04-10' }, end: { date: '2026-04-11' } },
    });
    const { calendarConfigRepo, esRepo } = setupTickler();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('create_tickler')!({
      title: 'Dentist appointment prep',
      due_date: '2026-04-10',
      due_time: 'all_day',
    });

    expect(mockEventsInsert).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({
        start: { date: '2026-04-10' },
      }),
    }));
  });

  it('prepends category to title when provided', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-cat', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-10T08:00:00' }, end: { dateTime: '2026-04-10T08:30:00' } },
    });
    const { calendarConfigRepo, esRepo } = setupTickler();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('create_tickler')!({
      title: 'Pay water bill',
      due_date: '2026-04-10',
      category: 'financial',
    });

    const parsed = parseToolResponse<{ title: string }>(response);
    expect(parsed.title).toBe('[financial] Pay water bill');
  });

  it('resolves friendly recurrence names to RRULE', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-rec', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-10T08:00:00' }, end: { dateTime: '2026-04-10T08:30:00' } },
    });
    const { calendarConfigRepo, esRepo } = setupTickler();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('create_tickler')!({
      title: 'Weekly review',
      due_date: '2026-04-10',
      recurrence: 'weekly',
    });

    expect(mockEventsInsert).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({
        recurrence: ['RRULE:FREQ=WEEKLY'],
      }),
    }));
  });

  it('passes raw RRULE strings through', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-rrule', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-10T08:00:00' }, end: { dateTime: '2026-04-10T08:30:00' } },
    });
    const { calendarConfigRepo, esRepo } = setupTickler();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('create_tickler')!({
      title: 'Custom recurrence',
      due_date: '2026-04-10',
      recurrence: 'RRULE:FREQ=MONTHLY;BYDAY=1FR',
    });

    expect(mockEventsInsert).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({
        recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=1FR'],
      }),
    }));
  });

  it('writes tickler to ES under USER_ID with isTickler=true', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-es', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-10T08:00:00' }, end: { dateTime: '2026-04-10T08:30:00' } },
    });
    const { calendarConfigRepo, esRepo, upsertFromGoogle } = setupTickler();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('create_tickler')!({
      title: 'ES tickler',
      due_date: '2026-04-10',
    });

    expect(upsertFromGoogle).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ title: 'ES tickler' }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// complete_tickler
// ---------------------------------------------------------------------------

describe('complete_tickler tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupCompleteTickler() {
    const calendarConfigRepo = makeCalendarConfigRepo({
      getByRole: vi.fn().mockResolvedValue(
        makeCalendarConfig({ calendar_id: 'tickler-cal-id', role: 'tickler' }),
      ),
    });
    const deleteByDocId = vi.fn();
    const esRepo = makeESCalendarRepo({ deleteByDocId });
    return { calendarConfigRepo, esRepo, deleteByDocId };
  }

  it('deletes a single instance (not series); fetches tickler-calendar for USER_ID', async () => {
    mockEventsDelete.mockResolvedValue({});
    const { calendarConfigRepo, esRepo } = setupCompleteTickler();
    const getByRoleSpy = calendarConfigRepo.getByRole as ReturnType<typeof vi.fn>;

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('complete_tickler')!({
      event_id: 'tickler-single',
    });

    expect(getByRoleSpy).toHaveBeenCalledWith(USER_ID, 'tickler');
    expect(mockEventsDelete).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'tickler-cal-id',
      eventId: 'tickler-single',
    }));
    const parsed = parseToolResponse<{ success: boolean; deleted_series: boolean }>(response);
    expect(parsed.success).toBe(true);
    expect(parsed.deleted_series).toBe(false);
  });

  it('deletes entire series when delete_series=true and recurring', async () => {
    mockEventsGet.mockResolvedValue({
      data: { recurringEventId: 'parent-series-id' },
    });
    mockEventsDelete.mockResolvedValue({});
    const { calendarConfigRepo, esRepo } = setupCompleteTickler();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('complete_tickler')!({
      event_id: 'instance-id_20260410T050000Z',
      delete_series: true,
    });

    expect(mockEventsDelete).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'parent-series-id',
    }));
    const parsed = parseToolResponse<{ deleted_series: boolean; event_id: string }>(response);
    expect(parsed.deleted_series).toBe(true);
    expect(parsed.event_id).toBe('parent-series-id');
  });

  it('removes from ES after completion', async () => {
    mockEventsDelete.mockResolvedValue({});
    const { calendarConfigRepo, esRepo, deleteByDocId } = setupCompleteTickler();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    await tools.get('complete_tickler')!({
      event_id: 'tickler-del',
    });

    expect(deleteByDocId).toHaveBeenCalledWith('tickler-tickler-del');
  });

  it('returns error when no tickler calendar configured (scoped to USER_ID)', async () => {
    const getByRole = vi.fn(async () => null);
    const calendarConfigRepo = makeCalendarConfigRepo({ getByRole });
    const esRepo = makeESCalendarRepo();

    const { registerTicklerTools } = await import('../tools/tickler.js');
    const tools = captureTools((s) =>
      registerTicklerTools(s, makeTokenRepo(), calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('complete_tickler')!({
      event_id: 'some-id',
    });

    expect(getByRole).toHaveBeenCalledWith(USER_ID, 'tickler');
    const parsed = parseToolResponse<{ success: boolean; error: string }>(response);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('No tickler calendar');
  });
});

// ---------------------------------------------------------------------------
// check_availability
// ---------------------------------------------------------------------------

describe('check_availability tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries Google FreeBusy API in google mode', async () => {
    mockFreebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          'test@example.com': {
            busy: [{ start: '2026-04-06T10:00:00Z', end: '2026-04-06T11:00:00Z' }],
          },
          primary: { busy: [] },
        },
      },
    });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), makeUserSettingsRepo(), makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('check_availability')!({
      emails: ['test@example.com'],
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      source: 'google',
    });

    const parsed = parseToolResponse<{ source: string; 'test@example.com': { busy: Array<unknown> } }>(response);
    expect(parsed.source).toBe('google');
    expect(parsed['test@example.com']).toBeDefined();
    expect(parsed['test@example.com'].busy).toHaveLength(1);
  });

  it('includes own calendar by default in google mode', async () => {
    mockFreebusyQuery.mockResolvedValue({
      data: { calendars: { primary: { busy: [] } } },
    });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), makeUserSettingsRepo(), makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    await tools.get('check_availability')!({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      source: 'google',
    });

    expect(mockFreebusyQuery).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({
        items: expect.arrayContaining([{ id: 'primary' }]),
      }),
    }));
  });

  it('returns isError envelope on exception', async () => {
    mockFreebusyQuery.mockRejectedValue(new Error('API quota exceeded'));

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), makeUserSettingsRepo(), makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('check_availability')!({
      emails: ['test@example.com'],
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      source: 'google',
    });

    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toContain('API quota exceeded');
  });
});

// ---------------------------------------------------------------------------
// set_timezone
// ---------------------------------------------------------------------------

describe('set_timezone tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates timezone via user settings repo (scoped to USER_ID)', async () => {
    const setTimezone = vi.fn(async () => undefined);
    const userSettingsRepo = makeUserSettingsRepo({ setTimezone });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), userSettingsRepo, makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('set_timezone')!({
      timezone: 'America/New_York',
    });

    expect(setTimezone).toHaveBeenCalledWith(USER_ID, 'America/New_York');
    const parsed = parseToolResponse<{ updated: boolean; timezone: string }>(response);
    expect(parsed.updated).toBe(true);
    expect(parsed.timezone).toBe('America/New_York');
  });

  it('rejects invalid timezone and does not call the repo', async () => {
    const setTimezone = vi.fn(async () => undefined);
    const userSettingsRepo = makeUserSettingsRepo({ setTimezone });

    const { registerCalendarTools } = await import('../tools/calendar.js');
    const tools = captureTools((s) =>
      registerCalendarTools(s, makeTokenRepo(), makeCalendarConfigRepo(), userSettingsRepo, makeESCalendarRepo(), GOOGLE_CONFIG, getUserId),
    );

    const response = await tools.get('set_timezone')!({
      timezone: 'Not/A/Real/Timezone',
    });

    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toContain('Invalid timezone');
    expect(setTimezone).not.toHaveBeenCalled();
  });
});
