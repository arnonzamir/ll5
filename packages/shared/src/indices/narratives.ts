import type { IndexDefinition } from './awareness.js';

/**
 * Narrative substrate — atomic, append-only observations tagged with one or
 * more subjects (person, place, group, topic). The agent writes these quietly
 * during conversation processing; recall queries them by subject.
 *
 * Subjects use a nested mapping so a single observation can belong to multiple
 * narratives (a message in the family group about Itamar tags both group and
 * person). Recall filters with `nested` queries.
 */
export const KNOWLEDGE_OBSERVATIONS_INDEX: IndexDefinition = {
  index: 'll5_knowledge_observations',
  mappings: {
    properties: {
      user_id: { type: 'keyword' },
      subjects: {
        type: 'nested',
        properties: {
          kind: { type: 'keyword' },
          ref: { type: 'keyword' },
        },
      },
      text: { type: 'text', analyzer: 'multilingual' },
      source: { type: 'keyword' },
      source_id: { type: 'keyword' },
      source_excerpt: { type: 'text', analyzer: 'multilingual' },
      confidence: { type: 'keyword' },
      mood: { type: 'keyword' },
      sensitive: { type: 'boolean' },
      observed_at: { type: 'date' },
      created_at: { type: 'date' },
    },
  },
};

/**
 * Lazy rollup of observations per subject. One narrative per
 * (user_id, subject.kind, subject.ref) — uniqueness enforced at the
 * application layer via deterministic doc id `{user_id}::{kind}::{ref}`.
 *
 * Status semantics:
 *   active   — recent observations exist; subject is live
 *   dormant  — no observations in N days (default 60); kept warm for recall
 *   closed   — thread genuinely done; still recallable but not surfaced
 *
 * Status transitions are agent-driven, never automatic.
 */
export const KNOWLEDGE_NARRATIVES_INDEX: IndexDefinition = {
  index: 'll5_knowledge_narratives',
  mappings: {
    properties: {
      user_id: { type: 'keyword' },
      subject: {
        properties: {
          kind: { type: 'keyword' },
          ref: { type: 'keyword' },
        },
      },
      title: { type: 'text', analyzer: 'multilingual', fields: { keyword: { type: 'keyword' } } },
      summary: { type: 'text', analyzer: 'multilingual' },
      current_mood: { type: 'keyword' },
      open_threads: { type: 'text', analyzer: 'multilingual' },
      recent_decisions: {
        type: 'nested',
        properties: {
          observed_at: { type: 'date' },
          text: { type: 'text', analyzer: 'multilingual' },
        },
      },
      participants: { type: 'keyword' },
      places: { type: 'keyword' },
      observation_count: { type: 'integer' },
      first_observed_at: { type: 'date' },
      last_observed_at: { type: 'date' },
      last_consolidated_at: { type: 'date' },
      sensitive: { type: 'boolean' },
      status: { type: 'keyword' },
      closed_reason: { type: 'text', analyzer: 'multilingual' },
    },
  },
};
