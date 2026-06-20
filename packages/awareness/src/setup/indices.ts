import type { Client } from '@elastic/elasticsearch';
import {
  AWARENESS_INDICES,
  AWARENESS_INDEX_SETTINGS,
  type IndexDefinition,
} from '@ll5/shared';
import { logger } from '../utils/logger.js';

// Indices exclusively owned by the awareness MCP (not written to by the gateway).
// The 7 ll5_awareness_* indices that the gateway also writes to are imported
// from @ll5/shared to prevent schema drift.
const AWARENESS_EXCLUSIVE_INDICES: IndexDefinition[] = [
  {
    index: 'll5_agent_journal',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        type: { type: 'keyword' },
        topic: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        content: { type: 'text', analyzer: 'multilingual' },
        signal: { type: 'keyword' },
        status: { type: 'keyword' },
        session_id: { type: 'keyword' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_agent_user_model',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        section: { type: 'keyword' },
        content: { type: 'object', enabled: false },
        last_updated: { type: 'date' },
        created_at: { type: 'date' },
      },
    },
  },
  // Governed agent "lessons" — operational/world knowledge the agent learns about
  // operating itself and the tools (e.g. "create_tickler due_time is local"). GLOBAL
  // (scope=world, shared across tenants — a living runbook), reconciled on write, and
  // recalled intentionally via hooks. User-specific knowledge does NOT live here — it
  // routes to ll5_agent_user_model. Versioned via ll5_agent_lessons_history.
  {
    index: 'll5_agent_lessons',
    mappings: {
      properties: {
        scope: { type: 'keyword' }, // 'world' (global operational knowledge)
        claim: { type: 'text', analyzer: 'multilingual' }, // the belief
        trigger: { type: 'text', analyzer: 'multilingual' }, // when it's relevant (recall key)
        detail: { type: 'text', analyzer: 'multilingual' }, // the body — why / how to apply
        durability: { type: 'keyword' }, // 'durable' | 'provisional'
        status: { type: 'keyword' }, // 'active' | 'retired'
        falsification_test: { type: 'text', analyzer: 'multilingual' }, // provisional: the check that retires it
        depends_on: { type: 'keyword' }, // provisional: tool/code path it compensates for
        expires: { type: 'date' }, // provisional: optional hard expiry
        supersedes: { type: 'keyword' },
        superseded_by: { type: 'keyword' },
        source: { type: 'text', analyzer: 'multilingual' }, // provenance: why/how learned
        author_user_id: { type: 'keyword' }, // which tenant's agent learned it (provenance only)
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
        retired_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_agent_lessons_history',
    mappings: {
      properties: {
        scope: { type: 'keyword' },
        claim: { type: 'text', analyzer: 'multilingual' },
        trigger: { type: 'text', analyzer: 'multilingual' },
        durability: { type: 'keyword' },
        status: { type: 'keyword' },
        falsification_test: { type: 'text', analyzer: 'multilingual' },
        depends_on: { type: 'keyword' },
        expires: { type: 'date' },
        supersedes: { type: 'keyword' },
        superseded_by: { type: 'keyword' },
        source: { type: 'text', analyzer: 'multilingual' },
        author_user_id: { type: 'keyword' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
        retired_at: { type: 'date' },
        archived_at: { type: 'date' },
        original_id: { type: 'keyword' },
      },
    },
  },
  {
    index: 'll5_media',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        url: { type: 'keyword' },
        mime_type: { type: 'keyword' },
        filename: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        size_bytes: { type: 'integer' },
        description: { type: 'text', analyzer: 'multilingual' },
        source: { type: 'keyword' },
        tags: { type: 'keyword' },
        created_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_media_links',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        media_id: { type: 'keyword' },
        entity_type: { type: 'keyword' },
        entity_id: { type: 'keyword' },
        linked_at: { type: 'date' },
      },
    },
  },
];

export async function ensureIndices(client: Client): Promise<void> {
  const all = [...AWARENESS_INDICES, ...AWARENESS_EXCLUSIVE_INDICES];
  for (const def of all) {
    const exists = await client.indices.exists({ index: def.index });
    if (!exists) {
      logger.info(`[ensureIndices][create] Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: AWARENESS_INDEX_SETTINGS,
        mappings: def.mappings,
      });
      logger.info(`[ensureIndices][create] Index created: ${def.index}`);
    } else {
      logger.debug(`[ensureIndices][create] Index already exists: ${def.index}`);
    }
  }
}
