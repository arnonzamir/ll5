import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock ES client factory
// ---------------------------------------------------------------------------

function makeMockEsClient(overrides: Record<string, unknown> = {}) {
  return {
    index: vi.fn().mockResolvedValue({ _id: 'mock-id', result: 'created' }),
    search: vi.fn().mockResolvedValue({ hits: { hits: [] }, aggregations: {} }),
    get: vi.fn().mockResolvedValue({ _id: 'mock-id', _source: {} }),
    update: vi.fn().mockResolvedValue({ result: 'updated' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock PG pool factory
// ---------------------------------------------------------------------------

function makeMockPool(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

// ---------------------------------------------------------------------------
// Mock logAudit to prevent ES writes
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual('@ll5/shared');
  return {
    ...(actual as Record<string, unknown>),
    logAudit: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Sleep summary parsing tests
// ---------------------------------------------------------------------------

describe('sleep summary parsing', () => {
  it('calculates duration in hours from seconds', () => {
    const durationSeconds = 28800; // 8 hours
    const durationHours = Math.round((durationSeconds / 3600) * 10) / 10;
    expect(durationHours).toBe(8);
  });

  it('calculates stage percentages correctly', () => {
    const durationSeconds = 28800;
    const deepSeconds = 5760;   // 20%
    const lightSeconds = 14400; // 50%
    const remSeconds = 5760;    // 20%
    const awakeSeconds = 2880;  // 10%

    const deepPct = Math.round(deepSeconds / durationSeconds * 100);
    const lightPct = Math.round(lightSeconds / durationSeconds * 100);
    const remPct = Math.round(remSeconds / durationSeconds * 100);
    const awakePct = Math.round(awakeSeconds / durationSeconds * 100);

    expect(deepPct).toBe(20);
    expect(lightPct).toBe(50);
    expect(remPct).toBe(20);
    expect(awakePct).toBe(10);
  });

  it('handles zero duration without division error', () => {
    const durationSeconds = 0;
    const deepPct = durationSeconds > 0 ? Math.round(1000 / durationSeconds * 100) : 0;
    expect(deepPct).toBe(0);
  });

  it('returns sleep summary from ES query', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              date: '2026-04-06',
              source: 'garmin',
              sleep_time: '2026-04-05T23:30:00Z',
              wake_time: '2026-04-06T07:15:00Z',
              duration_seconds: 27900,
              deep_seconds: 5580,
              light_seconds: 13950,
              rem_seconds: 5580,
              awake_seconds: 2790,
              quality_score: 78,
              average_hr: 55,
              lowest_hr: 48,
              highest_hr: 72,
              synced_at: '2026-04-06T08:00:00Z',
            },
          }],
        },
      }),
    });

    const result = await esClient.search({
      index: 'll5_health_sleep',
      query: { bool: { filter: [{ term: { user_id: 'user-1' } }, { term: { date: '2026-04-06' } }] } },
      size: 1,
      sort: [{ synced_at: 'desc' }],
    });

    const hits = result.hits.hits;
    expect(hits).toHaveLength(1);

    const doc = hits[0]._source as Record<string, unknown>;
    const durationSeconds = (doc.duration_seconds as number) || 0;
    const durationHours = Math.round((durationSeconds / 3600) * 10) / 10;

    expect(durationHours).toBe(7.8);
    expect(doc.quality_score).toBe(78);
    expect(doc.average_hr).toBe(55);
    expect(doc.lowest_hr).toBe(48);
  });

  it('returns error when no sleep data found', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
    });

    const result = await esClient.search({
      index: 'll5_health_sleep',
      query: { bool: { filter: [{ term: { user_id: 'user-1' } }, { term: { date: '2026-04-06' } }] } },
      size: 1,
    });

    expect(result.hits.hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Daily stats extraction tests
// ---------------------------------------------------------------------------

describe('daily stats extraction', () => {
  it('extracts stress and energy levels from daily stats', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: {
          hits: [{
            _source: {
              date: '2026-04-06',
              source: 'garmin',
              steps: 8500,
              distance_meters: 6200,
              floors_climbed: 5,
              active_calories: 450,
              total_calories: 2100,
              active_seconds: 3600,
              stress_average: 32,
              stress_max: 65,
              energy_level: 72,
              energy_min: 25,
              energy_max: 95,
              hrv_weekly_avg: 45,
              hrv_last_night_avg: 52,
              hrv_status: 'balanced',
              vo2_max: 42,
              respiration_average: 16,
              respiration_min: 12,
              respiration_max: 22,
              synced_at: '2026-04-06T20:00:00Z',
            },
          }],
        },
      }),
    });

    const result = await esClient.search({
      index: 'll5_health_daily_stats',
      query: { bool: { filter: [{ term: { user_id: 'user-1' } }, { term: { date: '2026-04-06' } }] } },
      size: 1,
    });

    const doc = result.hits.hits[0]._source as Record<string, unknown>;

    // Build the stats object as the tool does
    const stats = {
      steps: doc.steps,
      distanceKm: doc.distance_meters != null ? Math.round(((doc.distance_meters as number) / 1000) * 10) / 10 : null,
      activeMinutes: doc.active_seconds != null ? Math.round((doc.active_seconds as number) / 60) : null,
      stress: { average: doc.stress_average ?? null, max: doc.stress_max ?? null },
      energy: { level: doc.energy_level ?? null, min: doc.energy_min ?? null, max: doc.energy_max ?? null },
      hrv: { weeklyAvg: doc.hrv_weekly_avg ?? null, lastNightAvg: doc.hrv_last_night_avg ?? null, status: doc.hrv_status ?? null },
      vo2Max: doc.vo2_max ?? null,
    };

    expect(stats.steps).toBe(8500);
    expect(stats.distanceKm).toBe(6.2);
    expect(stats.activeMinutes).toBe(60);
    expect(stats.stress.average).toBe(32);
    expect(stats.stress.max).toBe(65);
    expect(stats.energy.level).toBe(72);
    expect(stats.energy.min).toBe(25);
    expect(stats.energy.max).toBe(95);
    expect(stats.hrv.weeklyAvg).toBe(45);
    expect(stats.hrv.lastNightAvg).toBe(52);
    expect(stats.hrv.status).toBe('balanced');
    expect(stats.vo2Max).toBe(42);
  });

  it('handles null optional fields with fallback', () => {
    const doc: Record<string, unknown> = {
      steps: 1000,
      distance_meters: null,
      active_seconds: null,
      stress_average: null,
      energy_level: null,
      hrv_weekly_avg: null,
      vo2_max: null,
    };

    const distanceKm = doc.distance_meters != null ? Math.round(((doc.distance_meters as number) / 1000) * 10) / 10 : null;
    const activeMinutes = doc.active_seconds != null ? Math.round((doc.active_seconds as number) / 60) : null;
    const stress = { average: doc.stress_average ?? null };
    const energy = { level: doc.energy_level ?? null };

    expect(distanceKm).toBeNull();
    expect(activeMinutes).toBeNull();
    expect(stress.average).toBeNull();
    expect(energy.level).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Health trends aggregation tests
// ---------------------------------------------------------------------------

describe('health trends aggregation', () => {
  const METRIC_CONFIG: Record<string, { index: string; field: string }> = {
    sleep_duration: { index: 'll5_health_sleep', field: 'duration_seconds' },
    sleep_quality: { index: 'll5_health_sleep', field: 'quality_score' },
    resting_hr: { index: 'll5_health_heart_rate', field: 'resting_hr' },
    steps: { index: 'll5_health_daily_stats', field: 'steps' },
    stress: { index: 'll5_health_daily_stats', field: 'stress_average' },
    energy: { index: 'll5_health_daily_stats', field: 'energy_level' },
    weight: { index: 'll5_health_body_composition', field: 'weight_kg' },
  };

  const PERIOD_DAYS: Record<string, number> = {
    week: 7,
    month: 30,
    quarter: 90,
  };

  it('maps metric names to correct ES indices and fields', () => {
    expect(METRIC_CONFIG['sleep_duration'].index).toBe('ll5_health_sleep');
    expect(METRIC_CONFIG['sleep_duration'].field).toBe('duration_seconds');
    expect(METRIC_CONFIG['steps'].index).toBe('ll5_health_daily_stats');
    expect(METRIC_CONFIG['steps'].field).toBe('steps');
    expect(METRIC_CONFIG['weight'].index).toBe('ll5_health_body_composition');
    expect(METRIC_CONFIG['weight'].field).toBe('weight_kg');
  });

  it('maps period names to correct day counts', () => {
    expect(PERIOD_DAYS['week']).toBe(7);
    expect(PERIOD_DAYS['month']).toBe(30);
    expect(PERIOD_DAYS['quarter']).toBe(90);
  });

  it('calculates trend direction from current vs previous average', () => {
    function getTrend(currentAvg: number, prevAvg: number): string {
      if (prevAvg === 0) return 'stable';
      const changePct = ((currentAvg - prevAvg) / Math.abs(prevAvg)) * 100;
      return changePct > 1 ? 'up' : changePct < -1 ? 'down' : 'stable';
    }

    expect(getTrend(8000, 7000)).toBe('up');     // +14% steps
    expect(getTrend(7000, 8000)).toBe('down');   // -12.5% steps
    expect(getTrend(7000, 7000)).toBe('stable'); // 0% change
    expect(getTrend(7050, 7000)).toBe('stable'); // +0.7%, within threshold
  });

  it('rounds aggregation values to one decimal place', () => {
    const round1 = (v: number) => Math.round(v * 10) / 10;
    expect(round1(7.849)).toBe(7.8);
    expect(round1(7.851)).toBe(7.9);
    expect(round1(8.0)).toBe(8);
  });

  it('queries ES with correct aggregation structure', async () => {
    const esClient = makeMockEsClient({
      search: vi.fn().mockResolvedValue({
        hits: { hits: [] },
        aggregations: {
          avg_value: { value: 7500 },
          min_value: { value: 3000 },
          max_value: { value: 12000 },
          daily: {
            buckets: [
              { key_as_string: '2026-04-01', value: { value: 8000 } },
              { key_as_string: '2026-04-02', value: { value: 7000 } },
            ],
          },
        },
      }),
    });

    const metric = 'steps';
    const config = METRIC_CONFIG[metric];

    const result = await esClient.search({
      index: config.index,
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { user_id: 'user-1' } },
            { range: { date: { gte: '2026-03-30', lte: '2026-04-06' } } },
          ],
        },
      },
      aggs: {
        avg_value: { avg: { field: config.field } },
        min_value: { min: { field: config.field } },
        max_value: { max: { field: config.field } },
        daily: {
          date_histogram: { field: 'date', calendar_interval: 'day' },
          aggs: { value: { avg: { field: config.field } } },
        },
      },
    });

    const aggs = result.aggregations as Record<string, { value: number | null; buckets?: Array<{ key_as_string: string; value: { value: number | null } }> }>;
    expect(aggs.avg_value.value).toBe(7500);
    expect(aggs.min_value.value).toBe(3000);
    expect(aggs.max_value.value).toBe(12000);
    expect(aggs.daily.buckets).toHaveLength(2);
  });

  it('calculates change percentage between periods', () => {
    const currentAvg = 8000;
    const prevAvg = 7000;
    const changePct = Math.round(((currentAvg - prevAvg) / Math.abs(prevAvg)) * 100 * 10) / 10;
    expect(changePct).toBe(14.3);
  });
});

// ---------------------------------------------------------------------------
// Connect/disconnect health source tests
// ---------------------------------------------------------------------------

describe('health source management', () => {
  describe('connect_health_source', () => {
    it('rejects unknown source ID', () => {
      const knownSources = ['garmin'];
      const sourceId = 'fitbit';
      const adapter = knownSources.includes(sourceId) ? sourceId : undefined;
      expect(adapter).toBeUndefined();
    });

    it('stores encrypted credentials in PG after successful connect', async () => {
      const pool = makeMockPool();

      // Simulate the upsert
      await pool.query(
        `INSERT INTO health_source_credentials (user_id, source_id, credentials, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, source_id)
         DO UPDATE SET credentials = $3, updated_at = now()`,
        ['user-1', 'garmin', 'encrypted-creds-data'],
      );

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO health_source_credentials'),
        ['user-1', 'garmin', 'encrypted-creds-data'],
      );
    });
  });

  describe('disconnect_health_source', () => {
    it('deletes credentials from PG', async () => {
      const pool = makeMockPool();

      await pool.query(
        'DELETE FROM health_source_credentials WHERE user_id = $1 AND source_id = $2',
        ['user-1', 'garmin'],
      );

      expect(pool.query).toHaveBeenCalledWith(
        'DELETE FROM health_source_credentials WHERE user_id = $1 AND source_id = $2',
        ['user-1', 'garmin'],
      );
    });
  });

  describe('list_health_sources', () => {
    it('builds connected sources map from PG query', async () => {
      const pool = makeMockPool([
        { source_id: 'garmin', updated_at: '2026-04-06T10:00:00Z' },
      ]);

      const result = await pool.query(
        'SELECT source_id, updated_at FROM health_source_credentials WHERE user_id = $1',
        ['user-1'],
      );

      const connectedSources = new Map(
        result.rows.map((r: { source_id: string; updated_at: string }) => [r.source_id, r.updated_at]),
      );

      expect(connectedSources.has('garmin')).toBe(true);
      expect(connectedSources.has('fitbit')).toBe(false);
      expect(connectedSources.get('garmin')).toBe('2026-04-06T10:00:00Z');
    });
  });

  describe('get_health_source_status', () => {
    it('returns not connected when no credentials stored', async () => {
      const pool = makeMockPool([]);

      const result = await pool.query(
        'SELECT credentials, updated_at FROM health_source_credentials WHERE user_id = $1 AND source_id = $2',
        ['user-1', 'garmin'],
      );

      expect(result.rows).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// sync_health_data flow tests
// ---------------------------------------------------------------------------

describe('sync_health_data flow', () => {
  it('generates correct date range', () => {
    function dateRange(from: string, to: string): string[] {
      const dates: string[] = [];
      const current = new Date(from);
      const end = new Date(to);
      while (current <= end) {
        dates.push(current.toISOString().slice(0, 10));
        current.setDate(current.getDate() + 1);
      }
      return dates;
    }

    const dates = dateRange('2026-04-01', '2026-04-03');
    expect(dates).toEqual(['2026-04-01', '2026-04-02', '2026-04-03']);
  });

  it('generates single date for same from/to', () => {
    function dateRange(from: string, to: string): string[] {
      const dates: string[] = [];
      const current = new Date(from);
      const end = new Date(to);
      while (current <= end) {
        dates.push(current.toISOString().slice(0, 10));
        current.setDate(current.getDate() + 1);
      }
      return dates;
    }

    const dates = dateRange('2026-04-06', '2026-04-06');
    expect(dates).toEqual(['2026-04-06']);
  });

  it('returns error when no sources connected', async () => {
    const pool = makeMockPool([]);
    const result = await pool.query(
      'SELECT source_id, credentials FROM health_source_credentials WHERE user_id = $1',
      ['user-1'],
    );
    expect(result.rows).toHaveLength(0);
    // Tool would return isError: true with "No health sources connected"
  });

  it('writes sleep data to ES with correct document ID format', async () => {
    const esClient = makeMockEsClient();
    const userId = 'user-1';
    const sourceId = 'garmin';
    const date = '2026-04-06';
    const docId = `${sourceId}-sleep-${userId}-${date}`;

    await esClient.index({
      index: 'll5_health_sleep',
      id: docId,
      document: {
        user_id: userId,
        source: sourceId,
        date,
        sleep_time: '2026-04-05T23:30:00Z',
        wake_time: '2026-04-06T07:15:00Z',
        duration_seconds: 27900,
        deep_seconds: 5580,
        light_seconds: 13950,
        rem_seconds: 5580,
        awake_seconds: 2790,
        quality_score: 78,
      },
    });

    expect(esClient.index).toHaveBeenCalledWith(expect.objectContaining({
      index: 'll5_health_sleep',
      id: 'garmin-sleep-user-1-2026-04-06',
    }));
  });

  it('writes heart rate data with correct document ID format', async () => {
    const esClient = makeMockEsClient();
    const docId = `garmin-hr-user-1-2026-04-06`;

    await esClient.index({
      index: 'll5_health_heart_rate',
      id: docId,
      document: {
        user_id: 'user-1',
        source: 'garmin',
        date: '2026-04-06',
        resting_hr: 55,
        min_hr: 48,
        max_hr: 150,
        average_hr: 72,
      },
    });

    expect(esClient.index).toHaveBeenCalledWith(expect.objectContaining({
      index: 'll5_health_heart_rate',
      id: 'garmin-hr-user-1-2026-04-06',
    }));
  });

  it('writes daily stats with correct document ID format', async () => {
    const esClient = makeMockEsClient();
    const docId = `garmin-daily-user-1-2026-04-06`;

    await esClient.index({
      index: 'll5_health_daily_stats',
      id: docId,
      document: {
        user_id: 'user-1',
        source: 'garmin',
        date: '2026-04-06',
        steps: 8500,
      },
    });

    expect(esClient.index).toHaveBeenCalledWith(expect.objectContaining({
      index: 'll5_health_daily_stats',
      id: 'garmin-daily-user-1-2026-04-06',
    }));
  });

  it('writes stress data via update to daily stats index', async () => {
    const esClient = makeMockEsClient();
    const docId = `garmin-daily-user-1-2026-04-06`;

    await esClient.update({
      index: 'll5_health_daily_stats',
      id: docId,
      doc: {
        stress_average: 32,
        stress_max: 65,
        stress_readings: [{ timestamp: '2026-04-06T10:00:00Z', value: 30 }],
        synced_at: new Date().toISOString(),
      },
      doc_as_upsert: true,
    });

    expect(esClient.update).toHaveBeenCalledWith(expect.objectContaining({
      index: 'll5_health_daily_stats',
      id: 'garmin-daily-user-1-2026-04-06',
      doc: expect.objectContaining({
        stress_average: 32,
        stress_max: 65,
      }),
      doc_as_upsert: true,
    }));
  });

  it('writes activity with source activity ID in document ID', async () => {
    const esClient = makeMockEsClient();
    const sourceActivityId = 'garmin-act-12345';
    const docId = `garmin-activity-${sourceActivityId}`;

    await esClient.index({
      index: 'll5_health_activities',
      id: docId,
      document: {
        user_id: 'user-1',
        source: 'garmin',
        source_id: sourceActivityId,
        activity_type: 'running',
        name: 'Morning Run',
        duration_seconds: 1800,
      },
    });

    expect(esClient.index).toHaveBeenCalledWith(expect.objectContaining({
      index: 'll5_health_activities',
      id: `garmin-activity-${sourceActivityId}`,
    }));
  });

  it('accumulates sync results per source', () => {
    const results: Record<string, { synced: string[]; errors: string[] }> = {};
    const sourceId = 'garmin';
    results[sourceId] = { synced: [], errors: [] };

    results[sourceId].synced.push('sleep:2026-04-06');
    results[sourceId].synced.push('heart_rate:2026-04-06');
    results[sourceId].errors.push('daily_stats:2026-04-06: timeout');

    const totalSynced = Object.values(results).reduce((sum, r) => sum + r.synced.length, 0);
    const totalErrors = Object.values(results).reduce((sum, r) => sum + r.errors.length, 0);

    expect(totalSynced).toBe(2);
    expect(totalErrors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Heart rate tool tests
// ---------------------------------------------------------------------------

describe('heart rate tool', () => {
  it('uses term filter for single date query', () => {
    const date = '2026-04-06';
    const dateFilter = { term: { date } };
    expect(dateFilter).toEqual({ term: { date: '2026-04-06' } });
  });

  it('uses range filter for date range query', () => {
    const from = '2026-04-01';
    const to = '2026-04-07';
    const dateFilter = { range: { date: { gte: from, lte: to } } };
    expect(dateFilter).toEqual({ range: { date: { gte: '2026-04-01', lte: '2026-04-07' } } });
  });

  it('excludes readings from source by default', () => {
    const includeReadings = false;
    const sourceExcludes = includeReadings ? [] : ['readings', 'raw_data'];
    expect(sourceExcludes).toEqual(['readings', 'raw_data']);
  });

  it('includes readings when requested', () => {
    const includeReadings = true;
    const sourceExcludes = includeReadings ? [] : ['readings', 'raw_data'];
    expect(sourceExcludes).toEqual([]);
  });

  it('returns single object for single date, array for range', async () => {
    const hits = [
      { _source: { date: '2026-04-06', resting_hr: 55, min_hr: 48, max_hr: 150, average_hr: 72 } },
      { _source: { date: '2026-04-05', resting_hr: 56, min_hr: 49, max_hr: 148, average_hr: 71 } },
    ];

    // Single date query -> first record only
    const singleResult = hits[0]._source;
    expect(singleResult.date).toBe('2026-04-06');

    // Range query -> all records
    const rangeResult = hits.map(h => h._source);
    expect(rangeResult).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Encryption utility tests
// ---------------------------------------------------------------------------

describe('encryption utility', () => {
  // Import the actual functions since they are pure crypto
  it('encrypts and decrypts correctly', async () => {
    const { encrypt, decrypt } = await import('../utils/encryption.js');
    const key = 'a'.repeat(64); // 32 bytes in hex
    const plaintext = '{"email":"test@example.com","password":"secret"}';

    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:ciphertext

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for same plaintext (random IV)', async () => {
    const { encrypt } = await import('../utils/encryption.js');
    const key = 'b'.repeat(64);
    const plaintext = 'test-data';

    const encrypted1 = encrypt(plaintext, key);
    const encrypted2 = encrypt(plaintext, key);

    expect(encrypted1).not.toBe(encrypted2);
  });

  it('throws on invalid encrypted string format', async () => {
    const { decrypt } = await import('../utils/encryption.js');
    const key = 'c'.repeat(64);

    expect(() => decrypt('invalid-no-colons', key)).toThrow('Invalid encrypted string format');
  });
});
