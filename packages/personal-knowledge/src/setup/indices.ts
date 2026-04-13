import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

const MULTILINGUAL_SETTINGS = {
  analysis: {
    analyzer: {
      multilingual: {
        type: 'custom' as const,
        tokenizer: 'standard',
        filter: ['lowercase', 'asciifolding'],
      },
    },
  },
};

const INDEX_SETTINGS = {
  number_of_shards: 1,
  number_of_replicas: 1,
  ...MULTILINGUAL_SETTINGS,
};

interface IndexDefinition {
  index: string;
  mappings: Record<string, unknown>;
}

const INDICES: IndexDefinition[] = [
  {
    index: 'll5_knowledge_profile',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        timezone: { type: 'keyword' },
        location: { type: 'text' },
        bio: { type: 'text', analyzer: 'multilingual' },
        birth_date: { type: 'date', format: 'yyyy-MM-dd||strict_date_optional_time' },
        languages: { type: 'keyword' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_knowledge_facts',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        type: { type: 'keyword' },
        category: { type: 'keyword' },
        content: { type: 'text', analyzer: 'multilingual' },
        provenance: { type: 'keyword' },
        confidence: { type: 'float' },
        source: { type: 'keyword' },
        tags: { type: 'keyword' },
        valid_from: { type: 'date' },
        valid_until: { type: 'date' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_knowledge_people',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        name: { type: 'text', analyzer: 'multilingual', fields: { keyword: { type: 'keyword' } } },
        aliases: { type: 'text', analyzer: 'multilingual' },
        relationship: { type: 'keyword' },
        contact_info: { type: 'object', enabled: false },
        tags: { type: 'keyword' },
        notes: { type: 'text', analyzer: 'multilingual' },
        status: { type: 'keyword' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_knowledge_places',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        name: { type: 'text', analyzer: 'multilingual', fields: { keyword: { type: 'keyword' } } },
        type: { type: 'keyword' },
        address: { type: 'text', analyzer: 'multilingual' },
        geo: { type: 'geo_point' },
        tags: { type: 'keyword' },
        notes: { type: 'text', analyzer: 'multilingual' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_knowledge_data_gaps',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        question: { type: 'text', analyzer: 'multilingual' },
        priority: { type: 'integer' },
        status: { type: 'keyword' },
        context: { type: 'text', analyzer: 'multilingual' },
        answer: { type: 'text', analyzer: 'multilingual' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_knowledge_networks',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        bssid: { type: 'keyword' },
        ssid: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        place_observations: {
          type: 'nested',
          properties: {
            place_id: { type: 'keyword' },
            place_name: { type: 'keyword' },
            count: { type: 'integer' },
            last_seen: { type: 'date' },
          },
        },
        manual_place_id: { type: 'keyword' },
        manual_place_name: { type: 'keyword' },
        label: { type: 'text' },
        total_observations: { type: 'integer' },
        first_seen: { type: 'date' },
        last_seen: { type: 'date' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
];

export async function ensureIndices(client: Client): Promise<void> {
  for (const def of INDICES) {
    const exists = await client.indices.exists({ index: def.index });
    if (!exists) {
      logger.info(`[ensureIndices][init] Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: INDEX_SETTINGS,
        mappings: def.mappings,
      });
      logger.info(`[ensureIndices][init] Index created: ${def.index}`);
    } else {
      // Update mapping to add any new fields (idempotent, non-breaking)
      try {
        await client.indices.putMapping({ index: def.index, ...def.mappings });
      } catch (e) {
        logger.warn(`[ensureIndices][putMapping] Failed for ${def.index}: ${e instanceof Error ? e.message : String(e)}`);
      }
      logger.debug(`[ensureIndices][init] Index already exists: ${def.index}`);
    }
  }
}
