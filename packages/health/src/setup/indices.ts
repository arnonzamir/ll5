import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

const INDEX_SETTINGS = {
  number_of_shards: 1,
  number_of_replicas: 1,
};

interface IndexDefinition {
  index: string;
  mappings: Record<string, unknown>;
}

const INDICES: IndexDefinition[] = [
  {
    index: 'll5_health_sleep',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        source: { type: 'keyword' },
        date: { type: 'date', format: 'yyyy-MM-dd' },
        sleep_time: { type: 'date' },
        wake_time: { type: 'date' },
        duration_seconds: { type: 'integer' },
        deep_seconds: { type: 'integer' },
        light_seconds: { type: 'integer' },
        rem_seconds: { type: 'integer' },
        awake_seconds: { type: 'integer' },
        quality_score: { type: 'float' },
        average_hr: { type: 'float' },
        lowest_hr: { type: 'float' },
        highest_hr: { type: 'float' },
        average_spo2: { type: 'float' },
        raw_data: { type: 'object', enabled: false },
        synced_at: { type: 'date' },
        created_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_health_heart_rate',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        source: { type: 'keyword' },
        date: { type: 'date', format: 'yyyy-MM-dd' },
        resting_hr: { type: 'integer' },
        min_hr: { type: 'integer' },
        max_hr: { type: 'integer' },
        average_hr: { type: 'integer' },
        zone_rest_seconds: { type: 'integer' },
        zone_1_seconds: { type: 'integer' },
        zone_2_seconds: { type: 'integer' },
        zone_3_seconds: { type: 'integer' },
        zone_4_seconds: { type: 'integer' },
        zone_5_seconds: { type: 'integer' },
        readings: { type: 'object', enabled: false },
        raw_data: { type: 'object', enabled: false },
        synced_at: { type: 'date' },
        created_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_health_daily_stats',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        source: { type: 'keyword' },
        date: { type: 'date', format: 'yyyy-MM-dd' },
        steps: { type: 'integer' },
        distance_meters: { type: 'float' },
        floors_climbed: { type: 'integer' },
        active_calories: { type: 'integer' },
        total_calories: { type: 'integer' },
        active_seconds: { type: 'integer' },
        stress_average: { type: 'float' },
        stress_max: { type: 'float' },
        stress_readings: { type: 'object', enabled: false },
        energy_level: { type: 'float' },
        energy_max: { type: 'float' },
        energy_min: { type: 'float' },
        spo2_average: { type: 'float' },
        respiration_average: { type: 'float' },
        raw_data: { type: 'object', enabled: false },
        synced_at: { type: 'date' },
        created_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_health_activities',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        source: { type: 'keyword' },
        source_id: { type: 'keyword' },
        activity_type: { type: 'keyword' },
        name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        start_time: { type: 'date' },
        end_time: { type: 'date' },
        duration_seconds: { type: 'integer' },
        distance_meters: { type: 'float' },
        calories: { type: 'integer' },
        average_hr: { type: 'integer' },
        max_hr: { type: 'integer' },
        average_pace: { type: 'float' },
        elevation_gain: { type: 'float' },
        zone_1_seconds: { type: 'integer' },
        zone_2_seconds: { type: 'integer' },
        zone_3_seconds: { type: 'integer' },
        zone_4_seconds: { type: 'integer' },
        zone_5_seconds: { type: 'integer' },
        training_effect: { type: 'float' },
        raw_data: { type: 'object', enabled: false },
        synced_at: { type: 'date' },
        created_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_health_body_composition',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        source: { type: 'keyword' },
        date: { type: 'date', format: 'yyyy-MM-dd' },
        weight_kg: { type: 'float' },
        body_fat_pct: { type: 'float' },
        muscle_mass_kg: { type: 'float' },
        bmi: { type: 'float' },
        bone_mass_kg: { type: 'float' },
        body_water_pct: { type: 'float' },
        raw_data: { type: 'object', enabled: false },
        synced_at: { type: 'date' },
        created_at: { type: 'date' },
      },
    },
  },
];

export async function ensureIndices(client: Client): Promise<void> {
  for (const def of INDICES) {
    const exists = await client.indices.exists({ index: def.index });
    if (!exists) {
      logger.info(`[ensureIndices][create] Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: INDEX_SETTINGS,
        mappings: def.mappings,
      });
      logger.info(`[ensureIndices][create] Index created: ${def.index}`);
    } else {
      logger.debug(`[ensureIndices][create] Index already exists: ${def.index}`);
    }
  }
}
