import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CalendarConfigRepository, CalendarConfigRecord, CalendarAccessMode } from '../repositories/interfaces/calendar-config.repository.js';
import type { UserSettingsRepository, UserSettings } from '../repositories/interfaces/user-settings.repository.js';
import type { OAuthTokenRepository, OAuthTokenRecord } from '../repositories/interfaces/oauth-token.repository.js';
import type { ESCalendarEventRepository, CalendarEventDoc } from '../repositories/elasticsearch/calendar-event.repository.js';
import type { GoogleClientConfig } from '../utils/google-client.js';

// ---------------------------------------------------------------------------
// Mock: @ll5/shared
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
  generateToken: vi.fn().mockReturnValue('mock-gw-token'),
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock: googleapis — intercept all Google API calls
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
// Mock: google-client utility
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

function createMockServer() {
  const tools = new Map<string, { handler: (params: Record<string, unknown>) => Promise<unknown> }>();
  return {
    tool: (name: string, _desc: string, _schema: unknown, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      tools.set(name, { handler });
    },
    call: async (name: string, params: Record<string, unknown> = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
  };
}

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

function createTokenRepo(): OAuthTokenRepository {
  return {
    store: vi.fn(),
    get: vi.fn().mockResolvedValue(makeTokenRecord()),
    updateAccessToken: vi.fn(),
    delete: vi.fn(),
  };
}

function createCalendarConfigRepo(): CalendarConfigRepository {
  return {
    upsert: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    getByRole: vi.fn().mockResolvedValue(null),
    setAccessMode: vi.fn(),
    getReadableCalendarIds: vi.fn().mockResolvedValue(['primary']),
    getWritableCalendarIds: vi.fn().mockResolvedValue(['primary']),
    deleteAll: vi.fn(),
  };
}

function createUserSettingsRepo(): UserSettingsRepository {
  return {
    get: vi.fn().mockResolvedValue({ user_id: USER_ID, timezone: 'Asia/Jerusalem' }),
    setTimezone: vi.fn(),
  };
}

function createESCalendarRepo(): ESCalendarEventRepository {
  return {
    query: vi.fn().mockResolvedValue([]),
    upsertFromGoogle: vi.fn(),
    deleteByDocId: vi.fn(),
  } as unknown as ESCalendarEventRepository;
}

// ===========================================================================
// Calendar Tools
// ===========================================================================

describe('list_events', () => {
  let server: ReturnType<typeof createMockServer>;
  let tokenRepo: OAuthTokenRepository;
  let calendarConfigRepo: CalendarConfigRepository;
  let userSettingsRepo: UserSettingsRepository;
  let esRepo: ESCalendarEventRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    tokenRepo = createTokenRepo();
    calendarConfigRepo = createCalendarConfigRepo();
    userSettingsRepo = createUserSettingsRepo();
    esRepo = createESCalendarRepo();

    const { registerCalendarTools } = await import('../tools/calendar.js');
    registerCalendarTools(server as any, tokenRepo, calendarConfigRepo, userSettingsRepo, esRepo, GOOGLE_CONFIG, getUserId);
  });

  it('reads events from ES repository', async () => {
    const docs = [
      makeCalendarEventDoc({ title: 'Meeting A', google_event_id: 'evt-1', calendar_id: 'primary', calendar_name: 'Primary' }),
      makeCalendarEventDoc({ title: 'Meeting B', google_event_id: 'evt-2', calendar_id: 'primary', calendar_name: 'Primary' }),
    ];
    vi.mocked(esRepo.query).mockResolvedValue(docs);

    const result = await server.call('list_events', {
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe('Meeting A');
    expect(parsed[1].title).toBe('Meeting B');
  });

  it('passes date range and calendar IDs to ES query', async () => {
    vi.mocked(esRepo.query).mockResolvedValue([]);

    await server.call('list_events', {
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      calendar_id: 'cal-specific',
    });

    expect(esRepo.query).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      calendarIds: ['cal-specific'],
      isTickler: false,
    }));
  });

  it('uses user timezone for default date range', async () => {
    vi.mocked(esRepo.query).mockResolvedValue([]);

    await server.call('list_events', {});

    expect(userSettingsRepo.get).toHaveBeenCalledWith(USER_ID);
    expect(esRepo.query).toHaveBeenCalled();
  });

  it('passes max_results as limit', async () => {
    vi.mocked(esRepo.query).mockResolvedValue([]);

    await server.call('list_events', { max_results: 10 });

    expect(esRepo.query).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      limit: 10,
    }));
  });

  it('passes query for text search', async () => {
    vi.mocked(esRepo.query).mockResolvedValue([]);

    await server.call('list_events', { query: 'standup' });

    expect(esRepo.query).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      query: 'standup',
    }));
  });
});

// ---------------------------------------------------------------------------
// create_event
// ---------------------------------------------------------------------------

describe('create_event', () => {
  let server: ReturnType<typeof createMockServer>;
  let tokenRepo: OAuthTokenRepository;
  let calendarConfigRepo: CalendarConfigRepository;
  let userSettingsRepo: UserSettingsRepository;
  let esRepo: ESCalendarEventRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    tokenRepo = createTokenRepo();
    calendarConfigRepo = createCalendarConfigRepo();
    userSettingsRepo = createUserSettingsRepo();
    esRepo = createESCalendarRepo();

    const { registerCalendarTools } = await import('../tools/calendar.js');
    registerCalendarTools(server as any, tokenRepo, calendarConfigRepo, userSettingsRepo, esRepo, GOOGLE_CONFIG, getUserId);
  });

  it('creates event via Google API and returns event ID', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'new-evt-1', htmlLink: 'https://calendar.google.com/event/new-evt-1', status: 'confirmed', start: { dateTime: '2026-04-06T10:00:00+03:00' }, end: { dateTime: '2026-04-06T11:00:00+03:00' } },
    });
    vi.mocked(calendarConfigRepo.list).mockResolvedValue([makeCalendarConfig()]);

    const result = await server.call('create_event', {
      title: 'Team Standup',
      start: '2026-04-06T10:00:00+03:00',
      end: '2026-04-06T11:00:00+03:00',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.event_id).toBe('new-evt-1');
    expect(parsed.status).toBe('confirmed');
  });

  it('writes through to ES after creation', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'evt-es', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-06T10:00:00Z' }, end: { dateTime: '2026-04-06T11:00:00Z' } },
    });
    vi.mocked(calendarConfigRepo.list).mockResolvedValue([makeCalendarConfig()]);

    await server.call('create_event', {
      title: 'ES Write Test',
      start: '2026-04-06T10:00:00Z',
      end: '2026-04-06T11:00:00Z',
    });

    expect(esRepo.upsertFromGoogle).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ event_id: 'evt-es', title: 'ES Write Test' }),
    );
  });

  it('rejects non-primary calendar without readwrite access', async () => {
    vi.mocked(calendarConfigRepo.getWritableCalendarIds).mockResolvedValue([]);

    const result = await server.call('create_event', {
      calendar_id: 'readonly-cal',
      title: 'Test',
      start: '2026-04-06T10:00:00Z',
      end: '2026-04-06T11:00:00Z',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toContain('not configured for readwrite');
    expect(mockEventsInsert).not.toHaveBeenCalled();
  });

  it('handles all-day events with date-only start/end', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'allday-evt', htmlLink: '', status: 'confirmed', start: { date: '2026-04-06' }, end: { date: '2026-04-07' } },
    });
    vi.mocked(calendarConfigRepo.list).mockResolvedValue([makeCalendarConfig()]);

    await server.call('create_event', {
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
  });
});

// ---------------------------------------------------------------------------
// configure_calendar
// ---------------------------------------------------------------------------

describe('configure_calendar', () => {
  let server: ReturnType<typeof createMockServer>;
  let calendarConfigRepo: CalendarConfigRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    const tokenRepo = createTokenRepo();
    calendarConfigRepo = createCalendarConfigRepo();
    const userSettingsRepo = createUserSettingsRepo();
    const esRepo = createESCalendarRepo();

    const { registerCalendarTools } = await import('../tools/calendar.js');
    registerCalendarTools(server as any, tokenRepo, calendarConfigRepo, userSettingsRepo, esRepo, GOOGLE_CONFIG, getUserId);
  });

  it('sets access mode to ignore', async () => {
    const result = await server.call('configure_calendar', {
      calendar_id: 'cal-1',
      access_mode: 'ignore',
    });

    expect(calendarConfigRepo.setAccessMode).toHaveBeenCalledWith(USER_ID, 'cal-1', 'ignore');
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.updated).toBe(true);
    expect(parsed.access_mode).toBe('ignore');
  });

  it('sets access mode to readwrite', async () => {
    await server.call('configure_calendar', {
      calendar_id: 'cal-2',
      access_mode: 'readwrite',
    });

    expect(calendarConfigRepo.setAccessMode).toHaveBeenCalledWith(USER_ID, 'cal-2', 'readwrite');
  });

  it('sets access mode to read', async () => {
    await server.call('configure_calendar', {
      calendar_id: 'cal-3',
      access_mode: 'read',
    });

    expect(calendarConfigRepo.setAccessMode).toHaveBeenCalledWith(USER_ID, 'cal-3', 'read');
  });
});

// ===========================================================================
// Tickler Tools
// ===========================================================================

describe('create_tickler', () => {
  let server: ReturnType<typeof createMockServer>;
  let tokenRepo: OAuthTokenRepository;
  let calendarConfigRepo: CalendarConfigRepository;
  let esRepo: ESCalendarEventRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    tokenRepo = createTokenRepo();
    calendarConfigRepo = createCalendarConfigRepo();
    esRepo = createESCalendarRepo();

    // Provide tickler calendar config
    vi.mocked(calendarConfigRepo.getByRole).mockResolvedValue(
      makeCalendarConfig({ calendar_id: 'tickler-cal-id', calendar_name: 'LL5 System', role: 'tickler' }),
    );

    const { registerTicklerTools } = await import('../tools/tickler.js');
    registerTicklerTools(server as any, tokenRepo, calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId);
  });

  it('creates a timed tickler with due_date and due_time', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-1', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-10T08:00:00' }, end: { dateTime: '2026-04-10T08:30:00' } },
    });

    const result = await server.call('create_tickler', {
      title: 'Check insurance',
      due_date: '2026-04-10',
      due_time: '09:00',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.title).toBe('Check insurance');
    expect(parsed.due_date).toBe('2026-04-10');
    expect(mockEventsInsert).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'tickler-cal-id',
    }));
  });

  it('creates an all-day tickler when due_time is "all_day"', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-allday', htmlLink: '', status: 'confirmed', start: { date: '2026-04-10' }, end: { date: '2026-04-11' } },
    });

    const result = await server.call('create_tickler', {
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

    const result = await server.call('create_tickler', {
      title: 'Pay water bill',
      due_date: '2026-04-10',
      category: 'financial',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.title).toBe('[financial] Pay water bill');
  });

  it('resolves friendly recurrence names to RRULE', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-rec', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-10T08:00:00' }, end: { dateTime: '2026-04-10T08:30:00' } },
    });

    await server.call('create_tickler', {
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

    await server.call('create_tickler', {
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

  it('writes tickler to ES with isTickler=true', async () => {
    mockEventsInsert.mockResolvedValue({
      data: { id: 'tickler-es', htmlLink: '', status: 'confirmed', start: { dateTime: '2026-04-10T08:00:00' }, end: { dateTime: '2026-04-10T08:30:00' } },
    });

    await server.call('create_tickler', {
      title: 'ES tickler',
      due_date: '2026-04-10',
    });

    expect(esRepo.upsertFromGoogle).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ title: 'ES tickler' }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// complete_tickler
// ---------------------------------------------------------------------------

describe('complete_tickler', () => {
  let server: ReturnType<typeof createMockServer>;
  let tokenRepo: OAuthTokenRepository;
  let calendarConfigRepo: CalendarConfigRepository;
  let esRepo: ESCalendarEventRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    tokenRepo = createTokenRepo();
    calendarConfigRepo = createCalendarConfigRepo();
    esRepo = createESCalendarRepo();

    vi.mocked(calendarConfigRepo.getByRole).mockResolvedValue(
      makeCalendarConfig({ calendar_id: 'tickler-cal-id', role: 'tickler' }),
    );

    const { registerTicklerTools } = await import('../tools/tickler.js');
    registerTicklerTools(server as any, tokenRepo, calendarConfigRepo, esRepo, GOOGLE_CONFIG, getUserId);
  });

  it('deletes a single instance (not series)', async () => {
    mockEventsDelete.mockResolvedValue({});

    const result = await server.call('complete_tickler', {
      event_id: 'tickler-single',
    });

    expect(mockEventsDelete).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'tickler-cal-id',
      eventId: 'tickler-single',
    }));
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.deleted_series).toBe(false);
  });

  it('deletes entire series when delete_series=true and recurring', async () => {
    mockEventsGet.mockResolvedValue({
      data: { recurringEventId: 'parent-series-id' },
    });
    mockEventsDelete.mockResolvedValue({});

    const result = await server.call('complete_tickler', {
      event_id: 'instance-id_20260410T050000Z',
      delete_series: true,
    });

    expect(mockEventsDelete).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'parent-series-id',
    }));
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.deleted_series).toBe(true);
    expect(parsed.event_id).toBe('parent-series-id');
  });

  it('removes from ES after completion', async () => {
    mockEventsDelete.mockResolvedValue({});

    await server.call('complete_tickler', {
      event_id: 'tickler-del',
    });

    expect(esRepo.deleteByDocId).toHaveBeenCalledWith('tickler-tickler-del');
  });

  it('returns error when no tickler calendar configured', async () => {
    vi.mocked(calendarConfigRepo.getByRole).mockResolvedValue(null);

    // Need to re-register with the updated mock
    const newServer = createMockServer();
    const newCalConfigRepo = createCalendarConfigRepo();
    vi.mocked(newCalConfigRepo.getByRole).mockResolvedValue(null);
    const { registerTicklerTools } = await import('../tools/tickler.js');
    registerTicklerTools(newServer as any, tokenRepo, newCalConfigRepo, esRepo, GOOGLE_CONFIG, getUserId);

    const result = await newServer.call('complete_tickler', {
      event_id: 'some-id',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('No tickler calendar');
  });
});

// ---------------------------------------------------------------------------
// check_availability
// ---------------------------------------------------------------------------

describe('check_availability', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();

    const { registerCalendarTools } = await import('../tools/calendar.js');
    registerCalendarTools(
      server as any,
      createTokenRepo(),
      createCalendarConfigRepo(),
      createUserSettingsRepo(),
      createESCalendarRepo(),
      GOOGLE_CONFIG,
      getUserId,
    );
  });

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

    const result = await server.call('check_availability', {
      emails: ['test@example.com'],
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      source: 'google',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.source).toBe('google');
    expect(parsed['test@example.com']).toBeDefined();
    expect(parsed['test@example.com'].busy).toHaveLength(1);
  });

  it('includes own calendar by default in google mode', async () => {
    mockFreebusyQuery.mockResolvedValue({
      data: { calendars: { primary: { busy: [] } } },
    });

    await server.call('check_availability', {
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

  it('returns error on exception', async () => {
    mockFreebusyQuery.mockRejectedValue(new Error('API quota exceeded'));

    const result = await server.call('check_availability', {
      emails: ['test@example.com'],
      from: '2026-04-06T00:00:00Z',
      to: '2026-04-06T23:59:59Z',
      source: 'google',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toContain('API quota exceeded');
    expect((result as any).isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// set_timezone
// ---------------------------------------------------------------------------

describe('set_timezone', () => {
  let server: ReturnType<typeof createMockServer>;
  let userSettingsRepo: UserSettingsRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    userSettingsRepo = createUserSettingsRepo();

    const { registerCalendarTools } = await import('../tools/calendar.js');
    registerCalendarTools(
      server as any,
      createTokenRepo(),
      createCalendarConfigRepo(),
      userSettingsRepo,
      createESCalendarRepo(),
      GOOGLE_CONFIG,
      getUserId,
    );
  });

  it('updates timezone via user settings repo', async () => {
    const result = await server.call('set_timezone', {
      timezone: 'America/New_York',
    });

    expect(userSettingsRepo.setTimezone).toHaveBeenCalledWith(USER_ID, 'America/New_York');
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.updated).toBe(true);
    expect(parsed.timezone).toBe('America/New_York');
  });

  it('rejects invalid timezone', async () => {
    const result = await server.call('set_timezone', {
      timezone: 'Not/A/Real/Timezone',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toContain('Invalid timezone');
    expect(userSettingsRepo.setTimezone).not.toHaveBeenCalled();
  });
});
