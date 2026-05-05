import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit } from '@ll5/shared';
import type { ObservationRepository } from '../repositories/interfaces/observation.repository.js';
import type { NarrativeRepository } from '../repositories/interfaces/narrative.repository.js';
import type { PersonRepository } from '../repositories/interfaces/person.repository.js';
import type { PlaceRepository } from '../repositories/interfaces/place.repository.js';
import type {
  SubjectRef,
  ObservationSource,
  Confidence,
  NarrativeStatus,
} from '../types/narrative.js';
import { logger } from '../utils/logger.js';

const subjectKindSchema = z.enum(['person', 'place', 'group', 'topic']);
const subjectSchema = z.object({
  kind: subjectKindSchema,
  ref: z.string().min(1),
});

const sourceSchema = z.enum([
  'whatsapp',
  'telegram',
  'chat',
  'system',
  'journal',
  'inference',
  'user_statement',
]);
const confidenceSchema = z.enum(['high', 'medium', 'low']);
const statusSchema = z.enum(['active', 'dormant', 'closed']);

interface ValidationCtx {
  personRepo: PersonRepository;
  placeRepo: PlaceRepository;
  userId: string;
}

/**
 * Validate that person and place subject refs point at real records.
 * Group (JID/chat_id) and topic (slug) are accepted as-is.
 * Returns { ok: true } or { ok: false, message }.
 */
async function validateSubjects(
  subjects: SubjectRef[],
  ctx: ValidationCtx,
): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const s of subjects) {
    if (s.kind === 'person') {
      const p = await ctx.personRepo.get(ctx.userId, s.ref);
      if (!p) return { ok: false, message: `Unknown person: ${s.ref}` };
    } else if (s.kind === 'place') {
      const p = await ctx.placeRepo.get(ctx.userId, s.ref);
      if (!p) return { ok: false, message: `Unknown place: ${s.ref}` };
    }
  }
  return { ok: true };
}

export function registerNarrativeTools(
  server: McpServer,
  observationRepo: ObservationRepository,
  narrativeRepo: NarrativeRepository,
  personRepo: PersonRepository,
  placeRepo: PlaceRepository,
  getUserId: () => string,
): void {
  // -------------------------------------------------------------------------
  // note_observation — primary write op
  // -------------------------------------------------------------------------
  server.tool(
    'note_observation',
    [
      'Quietly record an atomic observation about the user\'s world. Tag it with one or more subjects',
      '(person, place, group, topic). Use this constantly during conversation processing — it\'s the',
      'substrate for narratives. Confidence: `high` for explicit user statements, `medium` for clear',
      'implication, `low` for inference. Sensitive=true for tender topics (mood, self-esteem, kids,',
      'marital, money worry); flag is informational, not gating.',
    ].join(' '),
    {
      subjects: z.array(subjectSchema).min(1).describe('1+ subjects this observation is about'),
      text: z.string().min(1).describe('Your phrasing of what was observed'),
      source: sourceSchema.describe('Where this observation came from'),
      source_id: z.string().optional().describe('ID of the source record (chat message id, journal id, etc.)'),
      source_excerpt: z.string().optional().describe('The actual line that triggered this'),
      confidence: confidenceSchema.optional().describe('Default medium'),
      mood: z.string().optional().describe('Free-text mood note'),
      sensitive: z.boolean().optional().describe('Default false. Tender topics → true'),
      observed_at: z.string().optional().describe('ISO 8601. Defaults to now'),
    },
    async (params) => {
      const userId = getUserId();
      const subjects: SubjectRef[] = params.subjects;

      const v = await validateSubjects(subjects, { personRepo, placeRepo, userId });
      if (!v.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: v.message }) }],
          isError: true,
        };
      }

      const obs = await observationRepo.create(userId, {
        subjects,
        text: params.text,
        source: params.source as ObservationSource,
        sourceId: params.source_id,
        sourceExcerpt: params.source_excerpt,
        confidence: params.confidence as Confidence | undefined,
        mood: params.mood,
        sensitive: params.sensitive,
        observedAt: params.observed_at,
      });

      logAudit({
        user_id: userId,
        source: 'knowledge',
        action: 'create',
        entity_type: 'observation',
        entity_id: obs.id,
        summary: `Observation (${params.source}) on ${subjects.map((s) => `${s.kind}:${s.ref}`).join(', ')}`,
        metadata: {
          subjects: subjects.map((s) => `${s.kind}:${s.ref}`),
          confidence: obs.confidence,
          sensitive: obs.sensitive,
          mood: obs.mood,
        },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ observation: obs }) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // recall — primary read op
  // -------------------------------------------------------------------------
  server.tool(
    'recall',
    [
      'Pull what is known about one or more subjects. Use whenever an entity becomes salient in',
      'conversation (a person speaks, a place is mentioned, a topic comes up). Returns the rolled-up',
      'narrative if one exists + chronological observations, newest-first. Combine subjects+query for',
      'topical scoping ("what do I know about Tamar regarding the baby?"). Cheap; call freely.',
    ].join(' '),
    {
      subjects: z.array(subjectSchema).optional().describe('Subjects to recall about. At least one of subjects/query required'),
      query: z.string().optional().describe('Free-text search across observation text'),
      since: z.string().optional().describe('ISO 8601 — only observations on/after this date'),
      limit: z.number().min(1).max(200).optional().describe('Default 30'),
      include_narrative: z.boolean().optional().describe('Default true. Include rolled-up narrative summary if one exists'),
    },
    async (params) => {
      const userId = getUserId();

      if ((!params.subjects || params.subjects.length === 0) && !params.query) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'at least one of `subjects` or `query` required' }),
          }],
          isError: true,
        };
      }

      const subjects: SubjectRef[] = params.subjects ?? [];
      const observations = await observationRepo.recall(userId, {
        subjects: subjects.length > 0 ? subjects : undefined,
        query: params.query,
        since: params.since,
        limit: params.limit,
      });

      const includeNarrative = params.include_narrative ?? true;
      const narratives = [];
      if (includeNarrative) {
        for (const s of subjects) {
          const n = await narrativeRepo.getBySubject(userId, s);
          if (n) narratives.push(n);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ narratives, observations }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_narratives — for skills + dashboard
  // -------------------------------------------------------------------------
  server.tool(
    'list_narratives',
    'List narratives. Use for review skills and dashboard. Default returns active narratives sorted by recency.',
    {
      status: statusSchema.optional().describe('active / dormant / closed. Default active'),
      subject_kind: subjectKindSchema.optional().describe('Filter by subject kind'),
      participant_id: z.string().optional().describe('Person ID involved in the narrative'),
      stale_for_days: z.number().min(1).optional().describe('Active narratives untouched for N+ days'),
      query: z.string().optional().describe('Free-text search title + summary + open threads'),
      limit: z.number().min(1).max(200).optional().describe('Default 50'),
      offset: z.number().min(0).optional().describe('Pagination offset'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await narrativeRepo.list(userId, {
        status: (params.status ?? 'active') as NarrativeStatus,
        subjectKind: params.subject_kind,
        participantId: params.participant_id,
        staleForDays: params.stale_for_days,
        query: params.query,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ narratives: result.items, total: result.total }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // get_narrative — full retrieval for one subject
  // -------------------------------------------------------------------------
  server.tool(
    'get_narrative',
    'Full retrieval for one subject — narrative summary + recent observations timeline.',
    {
      subject: subjectSchema.describe('The subject to load'),
      observation_limit: z.number().min(1).max(500).optional().describe('Default 30, most recent first'),
    },
    async (params) => {
      const userId = getUserId();
      const subject: SubjectRef = params.subject;

      const narrative = await narrativeRepo.getBySubject(userId, subject);
      const observations = await observationRepo.recall(userId, {
        subjects: [subject],
        limit: params.observation_limit ?? 30,
      });

      if (!narrative && observations.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ narrative: null, observations: [], note: 'No narrative or observations exist for this subject yet.' }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ narrative, observations }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // upsert_narrative — explicit create/update
  // -------------------------------------------------------------------------
  server.tool(
    'upsert_narrative',
    [
      'Create or update a narrative for a subject. Title required on first create. Use this when',
      'naming a topic-slug subject ("workload-management" → "Workload squeeze at Sunbit"), when the',
      'user names a thread, or to transition status (active→dormant→closed). closed_reason required',
      'when status=closed. Sensitivity is bumped (logical OR), never lowered.',
    ].join(' '),
    {
      subject: subjectSchema.describe('Identifies the narrative (one per subject)'),
      title: z.string().optional().describe('Required on first create'),
      summary: z.string().optional().describe('Agent-rewritten summary'),
      current_mood: z.string().optional().describe('Snapshot mood'),
      open_threads: z.array(z.string()).optional().describe('Things to keep an eye on'),
      recent_decisions: z.array(z.object({
        observed_at: z.string(),
        text: z.string(),
      })).optional().describe('Recent decision points'),
      participants: z.array(z.string()).optional().describe('Person IDs involved'),
      places: z.array(z.string()).optional().describe('Place IDs involved'),
      observation_count: z.number().min(0).optional().describe('Total observations (set by consolidation)'),
      first_observed_at: z.string().optional(),
      last_observed_at: z.string().optional(),
      last_consolidated_at: z.string().optional().describe('Set when summary is rewritten'),
      sensitive: z.boolean().optional().describe('Bumps the flag; cannot be lowered here'),
      status: statusSchema.optional(),
      closed_reason: z.string().optional().describe('Required when status=closed'),
    },
    async (params) => {
      const userId = getUserId();
      const v = await validateSubjects([params.subject], { personRepo, placeRepo, userId });
      if (!v.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: v.message }) }],
          isError: true,
        };
      }

      try {
        const result = await narrativeRepo.upsert(userId, {
          subject: params.subject,
          title: params.title,
          summary: params.summary,
          currentMood: params.current_mood,
          openThreads: params.open_threads,
          recentDecisions: params.recent_decisions?.map((d) => ({
            observedAt: d.observed_at,
            text: d.text,
          })),
          participants: params.participants,
          places: params.places,
          observationCount: params.observation_count,
          firstObservedAt: params.first_observed_at,
          lastObservedAt: params.last_observed_at,
          lastConsolidatedAt: params.last_consolidated_at,
          sensitive: params.sensitive,
          status: params.status,
          closedReason: params.closed_reason,
        });

        logAudit({
          user_id: userId,
          source: 'knowledge',
          action: result.created ? 'create' : 'update',
          entity_type: 'narrative',
          entity_id: result.narrative.id,
          summary: `${result.created ? 'Created' : 'Updated'} narrative: ${result.narrative.title} [${params.subject.kind}:${params.subject.ref}]`,
          metadata: {
            subject_kind: params.subject.kind,
            subject_ref: params.subject.ref,
            status: result.narrative.status,
            sensitive: result.narrative.sensitive,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ narrative: result.narrative, created: result.created }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // delete_observation — retraction (no update; if wrong, delete and re-note)
  // -------------------------------------------------------------------------
  server.tool(
    'delete_observation',
    'Delete an observation by id. Observations are immutable; if you noted something wrong, delete and re-note.',
    {
      id: z.string().describe('Observation ID'),
    },
    async (params) => {
      const userId = getUserId();
      const deleted = await observationRepo.delete(userId, params.id);
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Observation not found' }) }],
          isError: true,
        };
      }

      logAudit({
        user_id: userId,
        source: 'knowledge',
        action: 'delete',
        entity_type: 'observation',
        entity_id: params.id,
        summary: `Deleted observation ${params.id}`,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true }) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // consolidate_narrative — helper: pulls fresh observations + current narrative
  //   so the agent can rewrite the summary in one call. The agent then calls
  //   upsert_narrative with the new summary and last_consolidated_at = now.
  // -------------------------------------------------------------------------
  server.tool(
    'consolidate_narrative',
    [
      'Helper for rewriting a narrative summary. Returns the current narrative + observations since',
      'last_consolidated_at (or all if never consolidated) + observation stats. After reading,',
      'YOU draft a new summary, current_mood, and open_threads, then call upsert_narrative with',
      'last_consolidated_at = now. Use this when N+ new observations have accumulated for a subject',
      'or when explicitly asked to refresh a thread.',
    ].join(' '),
    {
      subject: subjectSchema.describe('The subject to consolidate'),
      since_override: z.string().optional().describe('Override last_consolidated_at; ISO 8601'),
      observation_limit: z.number().min(1).max(1000).optional().describe('Default 200'),
    },
    async (params) => {
      const userId = getUserId();
      const subject: SubjectRef = params.subject;

      const v = await validateSubjects([subject], { personRepo, placeRepo, userId });
      if (!v.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: v.message }) }],
          isError: true,
        };
      }

      const narrative = await narrativeRepo.getBySubject(userId, subject);
      const since = params.since_override ?? narrative?.lastConsolidatedAt;
      const newObservations = await observationRepo.listForSubject(userId, subject, {
        since,
        limit: params.observation_limit ?? 200,
      });
      const stats = await observationRepo.statsForSubject(userId, subject);

      const now = new Date().toISOString();
      const guidance = narrative
        ? 'Rewrite the summary integrating the new observations. Update current_mood, open_threads, and recent_decisions if anything has shifted. Then call upsert_narrative with last_consolidated_at: "' + now + '".'
        : 'No narrative exists yet. Draft a first summary from the observations and call upsert_narrative with title (required), summary, current_mood, open_threads, and last_consolidated_at: "' + now + '".';

      logger.info('[consolidate_narrative] Prepared consolidation payload', {
        userId,
        subject: `${subject.kind}:${subject.ref}`,
        existing_narrative: !!narrative,
        new_observation_count: newObservations.length,
        total_observations: stats.count,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            narrative,
            new_observations: newObservations,
            stats,
            now,
            guidance,
          }),
        }],
      };
    },
  );
}
