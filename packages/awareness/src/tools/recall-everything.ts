import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logAudit } from '@ll5/shared';
import { logger } from '../utils/logger.js';

// recall_everything — the single, global "what do we know about X" entry point.
//
// Before this existed, answering "what do we know about <topic>" meant fanning out to
// search_knowledge (facts/people/places) + read_journal (which only matched `topic`, NOT
// content) + recall + calendar reads + message reads — and the agent routinely missed a
// store. That blind spot is exactly why a correction recorded three times in the journal
// never resurfaced. This tool runs ONE Elasticsearch query across every text-bearing store
// in the shared cluster, so a single call returns everything we hold on a subject.
//
// Storage note: this is a cross-store READ over the one shared ES cluster (no cross-MCP HTTP
// call). It reads the personal-knowledge indices (ll5_knowledge_*) and the awareness/agent
// indices together because, for retrieval, "what we know" has no domain boundary. Writes stay
// owned by each domain MCP; this only reads.
//
// Postgres stores (gtd actions/projects, gmail) are NOT in ES. When the ES sweep comes back
// thin, the response carries a `coverage`/`suggest_postgres` signal so the agent escalates to
// those tools (search_actions, gmail search) which it already holds. We deliberately do NOT
// wrap that hop in a subagent yet — it is one or two extra tool calls, not worth the machinery
// until the hint-based ladder proves insufficient.

// Every text/keyword field worth matching, unioned across all indices. `lenient: true` means
// a field absent from a given index's mapping is simply ignored for that index — so one
// multi_match cleanly spans heterogeneous schemas. Light boosts favour names/titles/claims.
const SEARCH_FIELDS = [
  'content',
  'claim^1.5',
  'topic^1.5',
  'trigger',
  'detail',
  'name^2',
  'title^2',
  'aliases',
  'notes',
  'address',
  'bio',
  'location',
  'summary',
  'text',
  'source_excerpt',
  'open_threads',
  'closed_reason',
  'description',
  'sender',
  'conversation_name',
  'entity_name',
  'activity',
  'question',
  'context',
  'answer',
  'tags',
  'transcript_text', // raw session transcripts (opt-in source only); ignored by lenient on other indices
];

// Highlight ONLY the content fields we actually search — never the scoping fields. A wildcard
// (`fields: {'*': {}}`) also highlights `user_id.keyword`, because the user-scoping FILTER term
// matches it, so the picked snippet becomes the bare user UUID instead of the matched text.
const HIGHLIGHT_FIELDS: Record<string, Record<string, never>> = Object.fromEntries(
  SEARCH_FIELDS.map((f) => [f.split('^')[0], {}]),
);

// Indices swept, mapped to the friendly source label returned to the agent. ll5_agent_lessons
// is world-scoped (no user_id) — included unconditionally; every other index is user-scoped.
const INDEX_LABEL: Record<string, string> = {
  ll5_knowledge_facts: 'fact',
  ll5_knowledge_people: 'person',
  ll5_knowledge_places: 'place',
  ll5_knowledge_profile: 'profile',
  ll5_knowledge_data_gaps: 'data_gap',
  ll5_knowledge_observations: 'observation',
  ll5_knowledge_narratives: 'narrative',
  ll5_agent_journal: 'journal',
  ll5_agent_lessons: 'lesson',
  ll5_awareness_calendar_events: 'calendar',
  ll5_awareness_messages: 'message',
  ll5_awareness_entity_statuses: 'entity_status',
  ll5_awareness_notable_events: 'notable_event',
  // Raw Claude session transcripts — the un-distilled layer. OPT-IN only (see below).
  ll5_session_history: 'session',
};
// Sessions are the raw transcript layer; they are NOT swept by default so months-old
// conversational chatter never dilutes the distilled "what do we know" result. They join
// the query only when the caller passes sources:["session"] — the deeper-reach rung of the
// same escalation ladder as the Postgres stores.
const SESSION_INDEX = 'll5_session_history';
const DEFAULT_INDICES = Object.keys(INDEX_LABEL).filter((i) => i !== SESSION_INDEX);
const ALL_LABELED_INDICES = Object.keys(INDEX_LABEL);
const LESSONS_INDEX = 'll5_agent_lessons';

// Below this total, the ES sweep is "thin" and the agent should also check Postgres stores.
const THIN_THRESHOLD = 3;

function clip(s: unknown, n = 240): string {
  const str = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s);
  const flat = str.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** One-line, human-readable gist per source so the agent sees what matched without digging. */
function summarize(label: string, s: Record<string, unknown>): string {
  switch (label) {
    case 'fact':
      return clip(s.content);
    case 'person':
      return clip(
        `${s.name ?? ''}${s.relationship ? ` (${s.relationship})` : ''}${s.notes ? ` — ${s.notes}` : ''}`,
      );
    case 'place':
      return clip(`${s.name ?? ''}${s.address ? ` — ${s.address}` : ''}`);
    case 'profile':
      return clip(s.bio || s.name);
    case 'data_gap':
      return clip(s.answer ? `Q: ${s.question} → A: ${s.answer}` : `OPEN Q: ${s.question}`);
    case 'observation':
      return clip(s.text);
    case 'narrative':
      return clip(s.title ? `${s.title}: ${s.summary ?? ''}` : s.summary);
    case 'journal':
      return clip(s.topic ? `[${s.topic}] ${s.content ?? ''}` : s.content);
    case 'lesson':
      return clip(s.claim);
    case 'calendar':
      return clip(`${s.title ?? ''}${s.start_time ? ` @ ${s.start_time}` : ''}${s.calendar_name ? ` (${s.calendar_name})` : ''}`);
    case 'message':
      return clip(`${s.sender || s.conversation_name || '?'}: ${s.content ?? ''}`);
    case 'entity_status':
      return clip(`${s.entity_name ?? ''}: ${s.summary || s.activity || ''}`);
    case 'notable_event':
      return clip(s.summary);
    case 'session':
      return clip(`session · ${s.message_count ?? '?'} msgs · last ${s.last_message ?? s.indexed_at ?? '?'}`);
    default:
      return clip(JSON.stringify(s));
  }
}

/** Best-available timestamp across the many date-field conventions, for display + recency. */
function pickTimestamp(s: Record<string, unknown>): string | null {
  const candidates = [
    s.created_at,
    s.timestamp,
    s.start_time,
    s.last_observed_at,
    s.observed_at,
    s.updated_at,
    s.last_updated,
    s.last_message, // session transcripts
    s.indexed_at, // session transcripts (fallback)
  ];
  for (const c of candidates) if (typeof c === 'string' && c) return c;
  return null;
}

interface Hit {
  _index: string;
  _id: string;
  _score: number;
  _source: Record<string, unknown>;
  highlight?: Record<string, string[]>;
}

export function registerRecallEverythingTool(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'recall_everything',
    'THE first call for "what do we know about X". One unified fuzzy search across EVERY stored ' +
      'knowledge source in one query: facts, people, places, profile, observations, narratives, ' +
      'journal entries (topic AND content), operating lessons, calendar events, IM messages, ' +
      'entity statuses, and notable events. Use this before asking the user or concluding we have ' +
      'no information — it closes the gap where data existed in a store but was never surfaced. ' +
      'If results come back thin, the response says so and names the deeper layers to check next: ' +
      'the raw conversation transcripts (pass sources:["session"] — NOT swept by default, since it is ' +
      'un-distilled chatter) and the Postgres stores (gtd, gmail). ' +
      'For a STATUS / "did X happen / what is the latest" question, pass mode:"timeline" — it returns EVERY ' +
      'match most-recent-first with no per-source cap, so a decisive recent update is never out-ranked by ' +
      'older verbose entries. The default response also flags (more_available) when ranking hid more than it showed.',
    {
      query: z.string().describe('Topic / name / phrase to look up (Hebrew or English).'),
      limit: z.number().min(1).max(100).optional().describe('Max results returned. Default 30.'),
      per_source_cap: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe('Max results from any single source, so one chatty store cannot drown the rest. Default 8.'),
      sources: z
        .array(z.string())
        .optional()
        .describe(
          'Restrict to these source labels (e.g. ["journal","calendar","fact"]). Default: all sources.',
        ),
      mode: z
        .enum(['relevant', 'timeline'])
        .optional()
        .describe(
          "'relevant' (default): top matches by relevance, capped per source — best for \"what do we know about X\". " +
            "'timeline': EXHAUSTIVE — EVERY match, most-recent-FIRST, NO per-source cap — use for status / \"did X happen / " +
            'what\'s the latest" questions. In relevant mode a decisive recent update (e.g. "picked up the glasses Friday") ' +
            'can be out-ranked and capped out by verbose older entries (the original order); timeline mode guarantees you see it.',
        ),
    },
    async (params) => {
      const userId = getUserId();
      const mode = params.mode ?? 'relevant';
      // Timeline (exhaustive) mode: more results, no per-source cap, time-ordered.
      const limit = params.limit ?? (mode === 'timeline' ? 50 : 30);
      const perSourceCap = mode === 'timeline' ? Infinity : (params.per_source_cap ?? 8);

      // Default sweep = distilled stores only. A sources filter can opt INTO the raw
      // session layer (and/or narrow to specific distilled stores).
      let indices = DEFAULT_INDICES;
      if (params.sources && params.sources.length > 0) {
        const wanted = new Set(params.sources.map((x) => x.toLowerCase()));
        indices = ALL_LABELED_INDICES.filter((idx) => wanted.has(INDEX_LABEL[idx]));
        if (indices.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'No matching sources',
                  valid_sources: [...new Set(Object.values(INDEX_LABEL))],
                }),
              },
            ],
          };
        }
      }

      const sessionSearched = indices.includes(SESSION_INDEX);

      // Fetch generously, then group + cap + trim in JS for a balanced, unified ranking.
      const fetchSize = Math.min(100, Math.max(limit, 60));

      try {
        const res = await esClient.search<Record<string, unknown>>({
          index: indices.join(','),
          ignore_unavailable: true,
          allow_no_indices: true,
          size: fetchSize,
          // True match count per index (not just the fetched page) → the "shown of matched"
          // cap signal, so the agent knows when relevance ranking hid more than it returned.
          track_total_hits: true,
          aggs: { by_index: { terms: { field: '_index', size: 30 } } },
          query: {
            bool: {
              must: [
                {
                  multi_match: {
                    query: params.query,
                    fields: SEARCH_FIELDS,
                    type: 'best_fields',
                    fuzziness: 'AUTO',
                    lenient: true,
                  },
                },
              ],
              // user_id scoping: every user index matches the tenant; the world-scoped
              // lessons index (no user_id) is admitted by _index.
              filter: [
                {
                  bool: {
                    should: [
                      { term: { user_id: userId } }, // distilled indices map user_id as keyword
                      { term: { 'user_id.keyword': userId } }, // session_history is dynamic-mapped (text+keyword)
                      { term: { _index: LESSONS_INDEX } }, // world-scoped lessons (no user_id)
                    ],
                    minimum_should_match: 1,
                  },
                },
              ],
              // Retired lessons should never resurface. No other swept index uses
              // status:'retired', so this is a lessons-only exclusion in practice.
              must_not: [{ term: { status: 'retired' } }],
            },
          },
          highlight: {
            fields: HIGHLIGHT_FIELDS,
            fragment_size: 140,
            number_of_fragments: 1,
          },
        });

        const hits = (res.hits?.hits ?? []) as unknown as Hit[];

        // Group by source, cap per source, then flatten back into one score-ranked list.
        const grouped = new Map<string, Hit[]>();
        for (const h of hits) {
          const label = INDEX_LABEL[h._index] ?? h._index;
          const arr = grouped.get(label) ?? [];
          if (arr.length < perSourceCap) arr.push(h);
          grouped.set(label, arr);
        }

        const bySource: Record<string, number> = {};
        const flattened: Array<{
          source: string;
          id: string;
          score: number;
          timestamp: string | null;
          summary: string;
          highlight: string | null;
          data: Record<string, unknown>;
        }> = [];

        for (const [label, arr] of grouped) {
          bySource[label] = arr.length;
          for (const h of arr) {
            const hl = h.highlight ? Object.values(h.highlight).flat()[0] ?? null : null;
            flattened.push({
              source: label,
              id: h._id,
              score: h._score,
              timestamp: pickTimestamp(h._source),
              summary: summarize(label, h._source),
              highlight: hl,
              data: h._source,
            });
          }
        }

        // Order: timeline = most-recent-first (the decisive update leads, and recency is
        // guaranteed in the slice); relevant = best-scoring first.
        if (mode === 'timeline') {
          flattened.sort((a, b) => {
            const ta = a.timestamp ? Date.parse(a.timestamp) : -Infinity;
            const tb = b.timestamp ? Date.parse(b.timestamp) : -Infinity;
            return tb - ta;
          });
        } else {
          flattened.sort((a, b) => b.score - a.score);
        }
        const results = flattened.slice(0, limit);
        const total = results.length;

        // True matched-per-source (from the agg) vs what we actually returned → the cap signal.
        const matchedBySource: Record<string, number> = {};
        for (const b of ((res.aggregations?.by_index as { buckets?: Array<{ key: string; doc_count: number }> })?.buckets ?? [])) {
          const label = INDEX_LABEL[b.key] ?? b.key;
          matchedBySource[label] = (matchedBySource[label] ?? 0) + b.doc_count;
        }
        // Sources where relevance ranking hid more than it surfaced — these are where a
        // status/"did X happen" answer could be buried. Empty in timeline mode (no cap).
        const moreAvailable: Record<string, { shown: number; matched: number }> = {};
        for (const [label, shown] of Object.entries(bySource)) {
          const matched = matchedBySource[label] ?? shown;
          if (matched > shown) moreAvailable[label] = { shown, matched };
        }

        const coverage = total === 0 ? 'empty' : total < THIN_THRESHOLD ? 'thin' : 'rich';
        const thin = coverage !== 'rich';

        logger.info('[recall_everything] sweep', {
          query: params.query,
          userId,
          indices: indices.length,
          total,
          coverage,
        });

        // Coverage telemetry → ll5_audit_log (auto-carries session_id from request context,
        // so a sweep can be correlated to the conversation it grounded). Lets the usage watch
        // report not just IF recall is used but WHETHER it returns useful results.
        logAudit({
          user_id: userId,
          source: 'awareness',
          action: 'recall_sweep',
          entity_type: 'recall',
          entity_id: params.query.slice(0, 64),
          summary: `recall "${params.query}" → ${coverage} (${total} hits / ${Object.keys(bySource).length} sources)`,
          metadata: {
            query: params.query,
            mode,
            coverage,
            total,
            by_source: bySource,
            sources_searched: indices.map((i) => INDEX_LABEL[i] ?? i),
            session_searched: sessionSearched,
            suggest_sessions: thin && !sessionSearched,
            capped_sources: Object.keys(moreAvailable),
          },
        });

        // In relevant mode, flag when ranking hid more than it showed — the case where a
        // decisive recent update can be out-ranked. Suppressed in timeline mode (nothing capped).
        const capped = mode === 'relevant' && Object.keys(moreAvailable).length > 0;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                query: params.query,
                mode,
                coverage,
                total,
                by_source: bySource,
                results,
                ...(capped
                  ? {
                      more_available: moreAvailable,
                      timeline_hint:
                        'Relevance ranking capped some sources (shown < matched). If this is a status / ' +
                        '"did X happen / what\'s the latest" question, re-run with mode:"timeline" — the ' +
                        'decisive recent entry may be beyond the relevance cut.',
                    }
                  : {}),
                ...(thin
                  ? {
                      suggest_postgres: ['gtd', 'gmail'],
                      ...(sessionSearched ? {} : { suggest_sessions: true }),
                      note:
                        'Distilled sweep was sparse. ' +
                        (sessionSearched
                          ? ''
                          : 'Re-run with sources:["session"] to search the raw conversation transcripts, and ') +
                        'check the Postgres stores not covered here — gtd (search_actions / list_projects) and gmail — ' +
                        'before concluding we have nothing.',
                    }
                  : {}),
              }),
            },
          ],
        };
      } catch (err) {
        logger.error('[recall_everything] search failed', { error: String(err), query: params.query });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'recall_everything search failed',
                detail: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
        };
      }
    },
  );
}
