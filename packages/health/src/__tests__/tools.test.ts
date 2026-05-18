import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @ll5/shared so logAudit doesn't write to ES during tests.
// Hoisted before any tool module imports it.
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ll5/shared');
  return {
    ...actual,
    logAudit: vi.fn(),
  };
});

import { logAudit } from '@ll5/shared';
import { registerSourceTools } from '../tools/sources.js';
import { registerSleepTools } from '../tools/sleep.js';
import { registerHeartRateTools } from '../tools/heart-rate.js';
import { registerDailyStatsTools } from '../tools/daily-stats.js';
import { registerActivityTools } from '../tools/activities.js';
import { registerBodyCompositionTools } from '../tools/body-composition.js';
import { registerTrendTools } from '../tools/trends.js';
import { registerSyncTools } from '../tools/sync.js';
import { registerAdapter } from '../clients/registry.js';
import { encrypt } from '../utils/encryption.js';
import {
  captureTools,
  parseToolResponse,
  makeMockEsClient,
  makeMockPool,
  makeMockAdapter,
} from './_helpers.js';
import type { HealthSourceAdapter } from '../clients/adapter.js';

const USER_ID = 'user-test-1';
const ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex
const getUserId = () => USER_ID;

// Shared mock adapter that individual tests override per case via `Object.assign`
// on the instance returned by getAdapter('garmin'). To keep the registry global
// while still allowing per-test stubbing, we install a single proxy adapter
// whose handler methods are replaced before each test.
let currentAdapter: HealthSourceAdapter;

function installAdapter(adapter: HealthSourceAdapter): void {
  currentAdapter = adapter;
}

const proxyAdapter: HealthSourceAdapter = {
  sourceId: 'garmin',
  displayName: 'Garmin',
  connect: (userId, creds) => currentAdapter.connect(userId, creds),
  disconnect: (userId) => currentAdapter.disconnect(userId),
  getStatus: (userId) => currentAdapter.getStatus(userId),
  fetchSleep: (userId, date) => currentAdapter.fetchSleep(userId, date),
  fetchHeartRate: (userId, date) => currentAdapter.fetchHeartRate(userId, date),
  fetchDailyStats: (userId, date) => currentAdapter.fetchDailyStats(userId, date),
  fetchActivities: (userId, from, to) => currentAdapter.fetchActivities(userId, from, to),
  fetchBodyComposition: (userId, date) => currentAdapter.fetchBodyComposition(userId, date),
  fetchStress: (userId, date) => currentAdapter.fetchStress(userId, date),
};

beforeAll(() => {
  registerAdapter(proxyAdapter);
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every method throws if invoked without an explicit stub.
  installAdapter(makeMockAdapter());
});

// ===========================================================================
// Source management tools — back the proxy adapter + pg.Pool
// ===========================================================================

describe('connect_health_source tool handler', () => {
  it('rejects unknown source ID with isError envelope', async () => {
    const pool = makeMockPool();
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('connect_health_source')!({
      source_id: 'fitbit',
      credentials: { token: 'x' },
    });

    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toMatch(/Unknown health source: fitbit/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('invokes adapter.connect with userId + credentials and persists encrypted creds scoped to user_id', async () => {
    const connect = vi.fn(async () => undefined);
    installAdapter(makeMockAdapter({ connect }));

    const pool = makeMockPool();
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const creds = { email: 'me@example.com', password: 'secret' };
    const response = await tools.get('connect_health_source')!({
      source_id: 'garmin',
      credentials: creds,
    });

    expect(response.isError).toBeUndefined();
    expect(connect).toHaveBeenCalledWith(USER_ID, creds);

    // Multi-tenancy: user_id is the first positional arg in the upsert
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toMatch(/INSERT INTO health_source_credentials/);
    expect((values as unknown[])[0]).toBe(USER_ID);
    expect((values as unknown[])[1]).toBe('garmin');
    // (values[2] is the encrypted blob — not asserted)

    const parsed = parseToolResponse<{ success: boolean; source: string }>(response);
    expect(parsed.success).toBe(true);
    expect(parsed.source).toBe('garmin');

    // Audit log emitted for the connection
    expect(logAudit).toHaveBeenCalledTimes(1);
    const auditArg = (logAudit as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditArg.user_id).toBe(USER_ID);
    expect(auditArg.action).toBe('create');
    expect(auditArg.entity_type).toBe('health_source');
  });

  it('returns isError when adapter.connect throws', async () => {
    installAdapter(makeMockAdapter({
      connect: vi.fn(async () => { throw new Error('bad password'); }),
    }));

    const pool = makeMockPool();
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('connect_health_source')!({
      source_id: 'garmin',
      credentials: { email: 'x', password: 'y' },
    });

    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toMatch(/bad password/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('disconnect_health_source tool handler', () => {
  it('deletes PG row scoped to user_id + source_id and invokes adapter.disconnect', async () => {
    const disconnect = vi.fn(async () => undefined);
    installAdapter(makeMockAdapter({ disconnect }));

    const pool = makeMockPool();
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('disconnect_health_source')!({ source_id: 'garmin' });

    expect(response.isError).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith(USER_ID);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toMatch(/DELETE FROM health_source_credentials WHERE user_id = \$1 AND source_id = \$2/);
    expect(values).toEqual([USER_ID, 'garmin']);

    const parsed = parseToolResponse<{ success: boolean }>(response);
    expect(parsed.success).toBe(true);

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect((logAudit as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].action).toBe('delete');
  });

  it('rejects unknown source ID', async () => {
    const pool = makeMockPool();
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('disconnect_health_source')!({ source_id: 'whoop' });
    expect(response.isError).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('get_health_source_status tool handler', () => {
  it('returns connected:false when no credentials are stored', async () => {
    const pool = makeMockPool([]);
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('get_health_source_status')!({ source_id: 'garmin' });

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ connected: boolean; source: string }>(response);
    expect(parsed.connected).toBe(false);
    expect(parsed.source).toBe('garmin');

    // user_id-scoped lookup
    const [, values] = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(values).toEqual([USER_ID, 'garmin']);
  });

  it('decrypts stored credentials and forwards status from the adapter', async () => {
    const creds = { email: 'me@example.com', password: 'secret' };
    const encryptedCreds = encrypt(JSON.stringify(creds), ENCRYPTION_KEY);

    const connect = vi.fn(async () => undefined);
    const getStatus = vi.fn(async () => ({ connected: true, lastSync: '2026-04-06T00:00:00Z' }));
    installAdapter(makeMockAdapter({ connect, getStatus }));

    const pool = makeMockPool([{ credentials: encryptedCreds, updated_at: '2026-04-06T10:00:00Z' }]);
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('get_health_source_status')!({ source_id: 'garmin' });

    expect(response.isError).toBeUndefined();
    expect(connect).toHaveBeenCalledWith(USER_ID, creds);
    expect(getStatus).toHaveBeenCalledWith(USER_ID);

    const parsed = parseToolResponse<{ connected: boolean; lastSync: string; lastCredentialUpdate: string }>(response);
    expect(parsed.connected).toBe(true);
    expect(parsed.lastSync).toBe('2026-04-06T00:00:00Z');
    expect(parsed.lastCredentialUpdate).toBe('2026-04-06T10:00:00Z');
  });

  it('rejects unknown source ID', async () => {
    const pool = makeMockPool();
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('get_health_source_status')!({ source_id: 'oura' });
    expect(response.isError).toBe(true);
  });
});

describe('list_health_sources tool handler', () => {
  it('queries PG scoped to user_id and marks adapters as connected accordingly', async () => {
    const pool = makeMockPool([{ source_id: 'garmin', updated_at: '2026-04-06T10:00:00Z' }]);
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('list_health_sources')!({});

    const [sql, values] = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toMatch(/SELECT source_id, updated_at FROM health_source_credentials WHERE user_id = \$1/);
    expect(values).toEqual([USER_ID]);

    const parsed = parseToolResponse<{ sources: Array<{ sourceId: string; connected: boolean; lastCredentialUpdate: string | null }> }>(response);
    const garmin = parsed.sources.find((s) => s.sourceId === 'garmin');
    expect(garmin).toBeDefined();
    expect(garmin!.connected).toBe(true);
    expect(garmin!.lastCredentialUpdate).toBe('2026-04-06T10:00:00Z');
  });

  it('returns connected:false for sources with no stored credentials', async () => {
    const pool = makeMockPool([]);
    const tools = captureTools((s) => registerSourceTools(s, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('list_health_sources')!({});

    const parsed = parseToolResponse<{ sources: Array<{ sourceId: string; connected: boolean }> }>(response);
    const garmin = parsed.sources.find((s) => s.sourceId === 'garmin');
    expect(garmin!.connected).toBe(false);
  });
});

// ===========================================================================
// get_sleep_summary
// ===========================================================================

describe('get_sleep_summary tool handler', () => {
  it('queries ES with user_id + date filter and returns derived stage percentages', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              date: '2026-04-06',
              source: 'garmin',
              sleep_time: '2026-04-05T23:30:00Z',
              wake_time: '2026-04-06T07:15:00Z',
              duration_seconds: 28800,
              deep_seconds: 5760,
              light_seconds: 14400,
              rem_seconds: 5760,
              awake_seconds: 2880,
              quality_score: 82,
              average_hr: 55,
              lowest_hr: 48,
              highest_hr: 72,
              synced_at: '2026-04-06T08:00:00Z',
            },
          }],
        },
      }),
    });

    const tools = captureTools((s) => registerSleepTools(s, esClient, getUserId));
    const response = await tools.get('get_sleep_summary')!({ date: '2026-04-06' });

    // user_id-scoped ES query
    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall.index).toBe('ll5_health_sleep');
    expect(searchCall.query.bool.filter).toEqual(expect.arrayContaining([
      { term: { user_id: USER_ID } },
      { term: { date: '2026-04-06' } },
    ]));

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ sleep: Record<string, unknown> }>(response);
    expect(parsed.sleep.durationHours).toBe(8);
    expect(parsed.sleep.qualityScore).toBe(82);
    const stages = parsed.sleep.stages as Record<string, number>;
    expect(stages.deepPct).toBe(20);
    expect(stages.lightPct).toBe(50);
    expect(stages.remPct).toBe(20);
    expect(stages.awakePct).toBe(10);
  });

  it('returns isError when no sleep data exists for the date', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
    });
    const tools = captureTools((s) => registerSleepTools(s, esClient, getUserId));

    const response = await tools.get('get_sleep_summary')!({ date: '2026-04-06' });
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toMatch(/No sleep data found for 2026-04-06/);
  });

  it('falls back to today when date param is omitted', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
    });
    const tools = captureTools((s) => registerSleepTools(s, esClient, getUserId));
    await tools.get('get_sleep_summary')!({});

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dateFilter = (searchCall.query.bool.filter as Array<Record<string, unknown>>).find(
      (f) => 'term' in f && (f.term as Record<string, unknown>).date != null,
    );
    expect(dateFilter).toBeDefined();
    const today = new Date().toISOString().slice(0, 10);
    expect(((dateFilter as Record<string, unknown>).term as Record<string, unknown>).date).toBe(today);
  });
});

// ===========================================================================
// get_heart_rate
// ===========================================================================

describe('get_heart_rate tool handler', () => {
  it('uses term filter for a single date and returns a single object', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              date: '2026-04-06',
              source: 'garmin',
              resting_hr: 55, min_hr: 48, max_hr: 150, average_hr: 72,
              synced_at: '2026-04-06T20:00:00Z',
            },
          }],
        },
      }),
    });

    const tools = captureTools((s) => registerHeartRateTools(s, esClient, getUserId));
    const response = await tools.get('get_heart_rate')!({ date: '2026-04-06' });

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall.query.bool.filter).toEqual(expect.arrayContaining([
      { term: { user_id: USER_ID } },
      { term: { date: '2026-04-06' } },
    ]));
    // Readings excluded by default
    expect(searchCall._source.excludes).toEqual(['readings', 'raw_data']);

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ heartRate: { restingHr: number } }>(response);
    expect(parsed.heartRate.restingHr).toBe(55);
  });

  it('uses range filter for date range, returns array + count', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [
            { _source: { date: '2026-04-07', resting_hr: 56 } },
            { _source: { date: '2026-04-06', resting_hr: 55 } },
          ],
        },
      }),
    });
    const tools = captureTools((s) => registerHeartRateTools(s, esClient, getUserId));

    const response = await tools.get('get_heart_rate')!({ from: '2026-04-06', to: '2026-04-07' });

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall.query.bool.filter).toEqual(expect.arrayContaining([
      { term: { user_id: USER_ID } },
      { range: { date: { gte: '2026-04-06', lte: '2026-04-07' } } },
    ]));

    const parsed = parseToolResponse<{ heartRate: unknown[]; count: number }>(response);
    expect(parsed.count).toBe(2);
    expect(parsed.heartRate).toHaveLength(2);
  });

  it('does not exclude readings when include_readings is true', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: { hits: [{ _source: { date: '2026-04-06', resting_hr: 55, readings: [{ timestamp: 't', value: 60 }] } }] },
      }),
    });
    const tools = captureTools((s) => registerHeartRateTools(s, esClient, getUserId));
    await tools.get('get_heart_rate')!({ date: '2026-04-06', include_readings: true });

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall._source.excludes).toEqual([]);
  });

  it('returns isError when no records are found', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
    });
    const tools = captureTools((s) => registerHeartRateTools(s, esClient, getUserId));

    const response = await tools.get('get_heart_rate')!({ date: '2026-04-06' });
    expect(response.isError).toBe(true);
  });
});

// ===========================================================================
// get_daily_stats
// ===========================================================================

describe('get_daily_stats tool handler', () => {
  it('queries ES scoped to user_id + date and derives distanceKm / activeMinutes', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              date: '2026-04-06', source: 'garmin',
              steps: 8500, distance_meters: 6200,
              floors_climbed: 5,
              active_calories: 450, total_calories: 2100,
              active_seconds: 3600,
              stress_average: 32, stress_max: 65,
              energy_level: 72, energy_min: 25, energy_max: 95,
              hrv_weekly_avg: 45, hrv_last_night_avg: 52, hrv_status: 'balanced',
              vo2_max: 42,
              respiration_average: 16, respiration_min: 12, respiration_max: 22,
              synced_at: '2026-04-06T20:00:00Z',
            },
          }],
        },
      }),
    });

    const tools = captureTools((s) => registerDailyStatsTools(s, esClient, getUserId));
    const response = await tools.get('get_daily_stats')!({ date: '2026-04-06' });

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall.index).toBe('ll5_health_daily_stats');
    expect(searchCall.query.bool.filter).toEqual(expect.arrayContaining([
      { term: { user_id: USER_ID } },
      { term: { date: '2026-04-06' } },
    ]));

    const parsed = parseToolResponse<{ dailyStats: Record<string, unknown> }>(response);
    expect(parsed.dailyStats.steps).toBe(8500);
    expect(parsed.dailyStats.distanceKm).toBe(6.2);
    expect(parsed.dailyStats.activeMinutes).toBe(60);
    expect((parsed.dailyStats.stress as Record<string, number>).average).toBe(32);
    expect((parsed.dailyStats.energy as Record<string, number>).level).toBe(72);
    expect((parsed.dailyStats.hrv as Record<string, unknown>).status).toBe('balanced');
    expect(parsed.dailyStats.vo2Max).toBe(42);
  });

  it('coerces null optional fields to null in derived units', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              date: '2026-04-06', source: 'garmin',
              steps: 1000,
              distance_meters: null,
              active_seconds: null,
              stress_average: null, energy_level: null,
              hrv_weekly_avg: null, vo2_max: null,
            },
          }],
        },
      }),
    });
    const tools = captureTools((s) => registerDailyStatsTools(s, esClient, getUserId));

    const response = await tools.get('get_daily_stats')!({ date: '2026-04-06' });
    const parsed = parseToolResponse<{ dailyStats: Record<string, unknown> }>(response);
    expect(parsed.dailyStats.distanceKm).toBeNull();
    expect(parsed.dailyStats.activeMinutes).toBeNull();
    expect((parsed.dailyStats.stress as Record<string, unknown>).average).toBeNull();
    expect(parsed.dailyStats.vo2Max).toBeNull();
  });

  it('returns isError when no record exists', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
    });
    const tools = captureTools((s) => registerDailyStatsTools(s, esClient, getUserId));

    const response = await tools.get('get_daily_stats')!({ date: '2026-04-06' });
    expect(response.isError).toBe(true);
  });
});

// ===========================================================================
// get_activities
// ===========================================================================

describe('get_activities tool handler', () => {
  it('queries ES scoped to user_id + range with default 7-day window', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          total: { value: 1 },
          hits: [{
            _source: {
              source: 'garmin', source_id: 'a-1', activity_type: 'running', name: 'Morning Run',
              start_time: '2026-04-06T08:00:00Z', end_time: '2026-04-06T08:30:00Z',
              duration_seconds: 1800, distance_meters: 5000, calories: 320,
              average_hr: 142, max_hr: 165, elevation_gain: 30,
              synced_at: '2026-04-06T09:00:00Z',
            },
          }],
        },
      }),
    });

    const tools = captureTools((s) => registerActivityTools(s, esClient, getUserId));
    const response = await tools.get('get_activities')!({});

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall.index).toBe('ll5_health_activities');
    const filters = searchCall.query.bool.filter as Array<Record<string, unknown>>;
    expect(filters[0]).toEqual({ term: { user_id: USER_ID } });
    expect('range' in filters[1]).toBe(true);
    // Default size 10, no activity_type filter
    expect(searchCall.size).toBe(10);

    const parsed = parseToolResponse<{ activities: Array<Record<string, unknown>>; count: number; total: number }>(response);
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.activities[0].activityType).toBe('running');
    expect(parsed.activities[0].durationMinutes).toBe(30);
    expect(parsed.activities[0].distanceKm).toBe(5);
  });

  it('forwards activity_type filter and respects limit', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } }),
    });
    const tools = captureTools((s) => registerActivityTools(s, esClient, getUserId));

    await tools.get('get_activities')!({ activity_type: 'cycling', limit: 25, from: '2026-04-01', to: '2026-04-07' });

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall.size).toBe(25);
    const filters = searchCall.query.bool.filter as Array<Record<string, unknown>>;
    expect(filters).toEqual(expect.arrayContaining([
      { term: { user_id: USER_ID } },
      { term: { activity_type: 'cycling' } },
    ]));
  });
});

// ===========================================================================
// get_body_composition
// ===========================================================================

describe('get_body_composition tool handler', () => {
  it('returns single object for latest (no date / range) scoped to user_id', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              date: '2026-04-06', source: 'garmin',
              weight_kg: 75.4, body_fat_pct: 18.5, muscle_mass_kg: 35.2, bmi: 23.1,
              synced_at: '2026-04-06T07:00:00Z',
            },
          }],
        },
      }),
    });

    const tools = captureTools((s) => registerBodyCompositionTools(s, esClient, getUserId));
    const response = await tools.get('get_body_composition')!({});

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall.index).toBe('ll5_health_body_composition');
    expect(searchCall.query.bool.filter).toEqual([{ term: { user_id: USER_ID } }]);
    expect(searchCall.size).toBe(1);

    const parsed = parseToolResponse<{ bodyComposition: Record<string, unknown> }>(response);
    expect(parsed.bodyComposition.weightKg).toBe(75.4);
    expect(parsed.bodyComposition.bmi).toBe(23.1);
  });

  it('returns array when from/to range is supplied', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [
            { _source: { date: '2026-04-06', weight_kg: 75.4 } },
            { _source: { date: '2026-04-05', weight_kg: 75.7 } },
          ],
        },
      }),
    });
    const tools = captureTools((s) => registerBodyCompositionTools(s, esClient, getUserId));

    const response = await tools.get('get_body_composition')!({ from: '2026-04-01', to: '2026-04-06' });

    const searchCall = (esClient.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCall.size).toBe(90);
    expect(searchCall.query.bool.filter).toEqual(expect.arrayContaining([
      { term: { user_id: USER_ID } },
      { range: { date: { gte: '2026-04-01', lte: '2026-04-06' } } },
    ]));

    const parsed = parseToolResponse<{ bodyComposition: unknown[]; count: number }>(response);
    expect(parsed.count).toBe(2);
  });

  it('returns isError when no documents exist', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
    });
    const tools = captureTools((s) => registerBodyCompositionTools(s, esClient, getUserId));

    const response = await tools.get('get_body_composition')!({});
    expect(response.isError).toBe(true);
  });
});

// ===========================================================================
// get_health_trends
// ===========================================================================

describe('get_health_trends tool handler', () => {
  it('queries the metric-mapped ES index with user_id and computes change/direction vs previous period', async () => {
    const searchFn = vi.fn()
      .mockResolvedValueOnce({
        hits: { hits: [] },
        aggregations: {
          avg_value: { value: 8000 },
          min_value: { value: 3000 },
          max_value: { value: 12000 },
          daily: { buckets: [
            { key_as_string: '2026-04-05', value: { value: 8000 } },
            { key_as_string: '2026-04-06', value: { value: 8000 } },
          ] },
        },
      })
      .mockResolvedValueOnce({
        hits: { hits: [] },
        aggregations: { avg_value: { value: 7000 } },
      });

    const esClient = makeMockEsClient({ search: searchFn });
    const tools = captureTools((s) => registerTrendTools(s, esClient, getUserId));

    const response = await tools.get('get_health_trends')!({ metric: 'steps', period: 'week' });

    // First call hits the right index + field for "steps"
    const firstCall = searchFn.mock.calls[0][0];
    expect(firstCall.index).toBe('ll5_health_daily_stats');
    expect(firstCall.aggs.avg_value.avg.field).toBe('steps');
    // user_id scoped
    expect(firstCall.query.bool.filter).toEqual(expect.arrayContaining([
      { term: { user_id: USER_ID } },
    ]));

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ trend: Record<string, unknown> }>(response);
    const trend = parsed.trend;
    expect(trend.metric).toBe('steps');
    expect(trend.period).toBe('week');
    expect(trend.average).toBe(8000);
    expect(trend.min).toBe(3000);
    expect(trend.max).toBe(12000);
    expect(trend.dataPoints).toBe(2);
    // (8000-7000)/7000 * 100 = 14.285... -> 14.3
    expect(trend.changePct).toBe(14.3);
    expect(trend.direction).toBe('up');
    expect((trend.previousPeriod as Record<string, unknown>).average).toBe(7000);
  });

  it('skips the previous-period comparison when compare:false', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      hits: { hits: [] },
      aggregations: {
        avg_value: { value: 50 },
        min_value: { value: 40 },
        max_value: { value: 60 },
        daily: { buckets: [] },
      },
    });
    const esClient = makeMockEsClient({ search: searchFn });
    const tools = captureTools((s) => registerTrendTools(s, esClient, getUserId));

    const response = await tools.get('get_health_trends')!({ metric: 'resting_hr', compare: false });

    expect(searchFn).toHaveBeenCalledTimes(1);
    const parsed = parseToolResponse<{ trend: Record<string, unknown> }>(response);
    expect(parsed.trend.previousPeriod).toBeUndefined();
    expect(parsed.trend.changePct).toBeUndefined();
  });

  it('maps each metric name to the configured index and field', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      hits: { hits: [] },
      aggregations: { avg_value: { value: null }, min_value: { value: null }, max_value: { value: null }, daily: { buckets: [] } },
    });
    const esClient = makeMockEsClient({ search: searchFn });
    const tools = captureTools((s) => registerTrendTools(s, esClient, getUserId));

    await tools.get('get_health_trends')!({ metric: 'weight', compare: false });
    const call = searchFn.mock.calls[0][0];
    expect(call.index).toBe('ll5_health_body_composition');
    expect(call.aggs.avg_value.avg.field).toBe('weight_kg');
  });
});

// ===========================================================================
// sync_health_data
// ===========================================================================

describe('sync_health_data tool handler', () => {
  it('returns isError when the user has no connected sources', async () => {
    const esClient = makeMockEsClient();
    const pool = makeMockPool([]);
    const tools = captureTools((s) => registerSyncTools(s, esClient, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('sync_health_data')!({ from: '2026-04-06', to: '2026-04-06' });

    expect(response.isError).toBe(true);
    // user_id-scoped lookup
    const [sql, values] = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1/);
    expect(values).toEqual([USER_ID]);

    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toMatch(/No health sources connected/);
  });

  it('writes per-category docs scoped to user_id and reports per-source totals', async () => {
    const creds = { email: 'x', password: 'y' };
    const encryptedCreds = encrypt(JSON.stringify(creds), ENCRYPTION_KEY);

    const fetchSleep = vi.fn(async () => ({
      date: '2026-04-06',
      sleepTime: '2026-04-05T23:30:00Z',
      wakeTime: '2026-04-06T07:00:00Z',
      durationSeconds: 27000,
      deepSeconds: 5400, lightSeconds: 13500, remSeconds: 5400, awakeSeconds: 2700,
      qualityScore: 80,
    }));
    const fetchHeartRate = vi.fn(async () => ({
      date: '2026-04-06',
      restingHr: 55, minHr: 48, maxHr: 150, averageHr: 72,
      zones: { rest: 100, z1: 200, z2: 300, z3: 400, z4: 500, z5: 600 },
    }));
    const fetchActivities = vi.fn(async () => [{
      sourceActivityId: 'a-1',
      activityType: 'running', name: 'Run',
      startTime: '2026-04-06T08:00:00Z', endTime: '2026-04-06T08:30:00Z',
      durationSeconds: 1800,
    }]);

    installAdapter(makeMockAdapter({
      connect: vi.fn(async () => undefined),
      fetchSleep,
      fetchHeartRate,
      fetchActivities,
    }));

    const esClient = makeMockEsClient();
    const pool = makeMockPool([{ source_id: 'garmin', credentials: encryptedCreds }]);
    const tools = captureTools((s) => registerSyncTools(s, esClient, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('sync_health_data')!({
      from: '2026-04-06',
      to: '2026-04-06',
      categories: ['sleep', 'heart_rate', 'activities'],
    });

    // Adapter received userId for each fetch
    expect(fetchSleep).toHaveBeenCalledWith(USER_ID, '2026-04-06');
    expect(fetchHeartRate).toHaveBeenCalledWith(USER_ID, '2026-04-06');
    expect(fetchActivities).toHaveBeenCalledWith(USER_ID, '2026-04-06', '2026-04-06');

    // Three ES writes (sleep, heart_rate, one activity)
    expect(esClient.index).toHaveBeenCalledTimes(3);
    const indexCalls = (esClient.index as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

    const sleepCall = indexCalls.find((c) => c.index === 'll5_health_sleep')!;
    expect(sleepCall.id).toBe('garmin-sleep-user-test-1-2026-04-06');
    expect(sleepCall.document.user_id).toBe(USER_ID);

    const hrCall = indexCalls.find((c) => c.index === 'll5_health_heart_rate')!;
    expect(hrCall.id).toBe('garmin-hr-user-test-1-2026-04-06');
    expect(hrCall.document.user_id).toBe(USER_ID);

    const actCall = indexCalls.find((c) => c.index === 'll5_health_activities')!;
    expect(actCall.id).toBe('garmin-activity-a-1');
    expect(actCall.document.user_id).toBe(USER_ID);

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{
      from: string; to: string;
      totalSynced: number; totalErrors: number;
      results: Record<string, { synced: string[]; errors: string[] }>;
    }>(response);
    expect(parsed.from).toBe('2026-04-06');
    expect(parsed.totalSynced).toBe(3);
    expect(parsed.totalErrors).toBe(0);
    expect(parsed.results.garmin.synced).toEqual(expect.arrayContaining([
      'sleep:2026-04-06',
      'heart_rate:2026-04-06',
      'activities:1',
    ]));

    // logAudit fired once
    expect(logAudit).toHaveBeenCalledTimes(1);
    const audit = (logAudit as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.user_id).toBe(USER_ID);
    expect(audit.action).toBe('sync');
  });

  it('uses doc_as_upsert for stress writes', async () => {
    const creds = { email: 'x', password: 'y' };
    const encryptedCreds = encrypt(JSON.stringify(creds), ENCRYPTION_KEY);
    installAdapter(makeMockAdapter({
      connect: vi.fn(async () => undefined),
      fetchStress: vi.fn(async () => ({
        date: '2026-04-06', average: 32, max: 65,
        readings: [{ timestamp: '2026-04-06T10:00:00Z', value: 30 }],
      })),
    }));

    const esClient = makeMockEsClient();
    const pool = makeMockPool([{ source_id: 'garmin', credentials: encryptedCreds }]);
    const tools = captureTools((s) => registerSyncTools(s, esClient, pool, getUserId, ENCRYPTION_KEY));

    await tools.get('sync_health_data')!({
      from: '2026-04-06', to: '2026-04-06',
      categories: ['stress'],
    });

    expect(esClient.update).toHaveBeenCalledTimes(1);
    const updateCall = (esClient.update as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.index).toBe('ll5_health_daily_stats');
    expect(updateCall.id).toBe('garmin-daily-user-test-1-2026-04-06');
    expect(updateCall.doc_as_upsert).toBe(true);
    expect(updateCall.doc.stress_average).toBe(32);
    expect(updateCall.doc.stress_max).toBe(65);
  });

  it('captures per-source-per-fetch errors without failing the whole sync', async () => {
    const creds = { email: 'x', password: 'y' };
    const encryptedCreds = encrypt(JSON.stringify(creds), ENCRYPTION_KEY);

    installAdapter(makeMockAdapter({
      connect: vi.fn(async () => undefined),
      fetchSleep: vi.fn(async () => { throw new Error('timeout'); }),
    }));

    const esClient = makeMockEsClient();
    const pool = makeMockPool([{ source_id: 'garmin', credentials: encryptedCreds }]);
    const tools = captureTools((s) => registerSyncTools(s, esClient, pool, getUserId, ENCRYPTION_KEY));

    const response = await tools.get('sync_health_data')!({
      from: '2026-04-06', to: '2026-04-06',
      categories: ['sleep'],
    });

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ totalErrors: number; results: Record<string, { errors: string[] }> }>(response);
    expect(parsed.totalErrors).toBe(1);
    expect(parsed.results.garmin.errors[0]).toMatch(/sleep:2026-04-06: timeout/);
  });
});

// ===========================================================================
// Encryption utility (pure helper — already a real test in the original)
// ===========================================================================

describe('encryption utility', () => {
  it('round-trips plaintext through encrypt/decrypt with the same key', async () => {
    const { encrypt, decrypt } = await import('../utils/encryption.js');
    const key = 'a'.repeat(64);
    const plaintext = '{"email":"test@example.com","password":"secret"}';

    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(':')).toHaveLength(3);

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for identical plaintext (random IV)', async () => {
    const { encrypt } = await import('../utils/encryption.js');
    const key = 'b'.repeat(64);

    expect(encrypt('test-data', key)).not.toBe(encrypt('test-data', key));
  });

  it('throws on malformed input', async () => {
    const { decrypt } = await import('../utils/encryption.js');
    expect(() => decrypt('not-a-valid-blob', 'c'.repeat(64))).toThrow('Invalid encrypted string format');
  });
});
