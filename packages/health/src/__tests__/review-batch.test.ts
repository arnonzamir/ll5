import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

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

import { normalizeDailyStats } from '../clients/garmin/garmin-normalizer.js';
import { registerSyncTools } from '../tools/sync.js';
import { registerAdapter } from '../clients/registry.js';
import { encrypt } from '../utils/encryption.js';
import {
  captureTools,
  makeMockEsClient,
  makeMockPool,
  makeMockAdapter,
} from './_helpers.js';
import type { HealthSourceAdapter } from '../clients/adapter.js';

const USER_ID = 'user-test-1';
const ENCRYPTION_KEY = 'a'.repeat(64);
const getUserId = () => USER_ID;

// ===========================================================================
// Bug #2 — garmin-normalizer normalizeDailyStats activeSeconds precedence
// `summary?.activeSeconds ?? summary?.highlyActiveSeconds ?? summary?.moderateIntensityMinutes ? (...) : 0`
// `??` binds tighter than `?:`, so the whole left side becomes the `?:` test,
// returning the minutes computation whenever the chain is truthy (and NaN when
// moderateIntensityMinutes is undefined but the chain was truthy via another field).
// ===========================================================================

describe('normalizeDailyStats — activeSeconds source precedence (bug #2)', () => {
  it('returns activeSeconds verbatim when the summary provides it', () => {
    const result = normalizeDailyStats(
      { calendarDate: '2026-05-29', totalSteps: 8500, activeSeconds: 4200 },
      8500,
      '2026-05-29',
    );
    expect(result).not.toBeNull();
    expect(result!.activeSeconds).toBe(4200);
  });

  it('falls back to highlyActiveSeconds when activeSeconds is absent', () => {
    const result = normalizeDailyStats(
      { calendarDate: '2026-05-29', totalSteps: 8500, highlyActiveSeconds: 1800 },
      8500,
      '2026-05-29',
    );
    expect(result).not.toBeNull();
    expect(result!.activeSeconds).toBe(1800);
  });

  it('falls back to the intensity-minutes computation when only minutes are present', () => {
    const result = normalizeDailyStats(
      {
        calendarDate: '2026-05-29',
        totalSteps: 8500,
        moderateIntensityMinutes: 30,
        vigorousIntensityMinutes: 10,
      },
      8500,
      '2026-05-29',
    );
    expect(result).not.toBeNull();
    // (30 + 10) * 60 = 2400
    expect(result!.activeSeconds).toBe(2400);
  });

  it('returns 0 (never NaN) when no activity fields are present despite steps', () => {
    const result = normalizeDailyStats(
      { calendarDate: '2026-05-29', totalSteps: 8500 },
      8500,
      '2026-05-29',
    );
    expect(result).not.toBeNull();
    // LIVE PROOF reproduction: thousands of steps, no active fields → must be 0
    expect(result!.activeSeconds).toBe(0);
    expect(Number.isNaN(result!.activeSeconds)).toBe(false);
  });

  it('does NOT produce NaN when activeSeconds present but minutes undefined', () => {
    // With the buggy precedence, a truthy activeSeconds made the chain truthy and
    // then evaluated the minutes branch -> NaN (undefined + 0) * 60.
    const result = normalizeDailyStats(
      { calendarDate: '2026-05-29', totalSteps: 8500, activeSeconds: 4200 },
      8500,
      '2026-05-29',
    );
    expect(Number.isNaN(result!.activeSeconds)).toBe(false);
    expect(result!.activeSeconds).toBe(4200);
  });
});

// ===========================================================================
// Bug #6 — writeStressToES upsert must seed user_id/date/source on insert,
// exercised through the sync_health_data tool handler (its testable boundary).
// ===========================================================================

let currentAdapter: HealthSourceAdapter;
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
  currentAdapter = makeMockAdapter();
});

describe('sync_health_data — stress-first upsert seeds scoping fields (bug #6)', () => {
  it('upsert seeds user_id/date/source so a user_id-scoped read can find it', async () => {
    const encryptedCreds = encrypt(JSON.stringify({ email: 'x', password: 'y' }), ENCRYPTION_KEY);
    currentAdapter = makeMockAdapter({
      connect: vi.fn(async () => undefined),
      fetchStress: vi.fn(async () => ({
        date: '2026-04-06',
        average: 32,
        max: 65,
        readings: [{ timestamp: '2026-04-06T10:00:00Z', value: 30 }],
      })),
    });

    const esClient = makeMockEsClient();
    const pool = makeMockPool([{ source_id: 'garmin', credentials: encryptedCreds }]);
    const tools = captureTools((s) => registerSyncTools(s, esClient, pool, getUserId, ENCRYPTION_KEY));

    await tools.get('sync_health_data')!({
      from: '2026-04-06',
      to: '2026-04-06',
      categories: ['stress'],
    });

    expect(esClient.update).toHaveBeenCalledTimes(1);
    const updateCall = (esClient.update as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.index).toBe('ll5_health_daily_stats');
    expect(updateCall.id).toBe('garmin-daily-user-test-1-2026-04-06');
    expect(updateCall.doc_as_upsert).toBe(true);

    // Stress fields still present in the partial doc (existing-doc merge path)
    expect(updateCall.doc.stress_average).toBe(32);
    expect(updateCall.doc.stress_max).toBe(65);

    // CRITICAL: on insert (stress synced before daily_stats exists) the doc that
    // gets created MUST carry the scoping fields, else it is invisible to every
    // user_id-scoped read. With doc_as_upsert these live in `doc`.
    expect(updateCall.doc.user_id).toBe(USER_ID);
    expect(updateCall.doc.date).toBe('2026-04-06');
    expect(updateCall.doc.source).toBe('garmin');
  });
});

// ===========================================================================
// writeActivityToES doc id must be user-scoped (cross-tenant overwrite).
// The id was `${sourceId}-activity-${sourceActivityId}` with NO userId, while
// sourceId is the source TYPE ('garmin'). Two users whose provider activity IDs
// collide overwrite each other's activity doc (last-writer-wins), and a
// delete/reindex keyed on this id would cross tenants. Same class as the
// already-fixed writeStressToES orphan. Exercised through the sync_health_data
// tool handler (its testable boundary).
// ===========================================================================

async function syncActivitiesAs(
  userId: string,
  esClient: ReturnType<typeof makeMockEsClient>,
): Promise<void> {
  const encryptedCreds = encrypt(JSON.stringify({ email: 'x', password: 'y' }), ENCRYPTION_KEY);
  currentAdapter = makeMockAdapter({
    connect: vi.fn(async () => undefined),
    fetchActivities: vi.fn(async () => [
      {
        sourceActivityId: 'act-999',
        activityType: 'running',
        name: 'Morning Run',
        startTime: '2026-04-06T06:00:00Z',
        endTime: '2026-04-06T06:45:00Z',
        durationSeconds: 2700,
        distanceMeters: 5000,
        calories: 400,
        averageHr: 150,
        maxHr: 175,
        elevationGain: 30,
      },
    ]),
  });

  const pool = makeMockPool([{ source_id: 'garmin', credentials: encryptedCreds }]);
  const tools = captureTools((s) =>
    registerSyncTools(s, esClient, pool, () => userId, ENCRYPTION_KEY),
  );

  await tools.get('sync_health_data')!({
    from: '2026-04-06',
    to: '2026-04-06',
    categories: ['activities'],
  });
}

describe('sync_health_data — activity doc id is user-scoped (cross-tenant)', () => {
  it('two users with the same sourceActivityId produce different doc ids, both carrying user_id', async () => {
    const esA = makeMockEsClient();
    const esB = makeMockEsClient();

    await syncActivitiesAs('user-A', esA);
    await syncActivitiesAs('user-B', esB);

    expect(esA.index).toHaveBeenCalledTimes(1);
    expect(esB.index).toHaveBeenCalledTimes(1);

    const callA = (esA.index as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const callB = (esB.index as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(callA.index).toBe('ll5_health_activities');
    expect(callB.index).toBe('ll5_health_activities');

    // CRITICAL: same provider activity id ('act-999') must NOT collide across tenants.
    expect(callA.id).not.toBe(callB.id);
    expect(callA.id).toBe('garmin-activity-user-A-act-999');
    expect(callB.id).toBe('garmin-activity-user-B-act-999');

    // Both docs must carry their owning user_id (and the scoping siblings).
    expect(callA.document.user_id).toBe('user-A');
    expect(callB.document.user_id).toBe('user-B');
    expect(callA.document.source).toBe('garmin');
    expect(callA.document.date).toBe('2026-04-06');
  });
});
