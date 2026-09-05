import { z } from 'zod';
import { chooseLinkedNarrative, significantWords } from './subject-link.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit, capItems, pageFields, resolveOffset, resolveCap } from '@ll5/shared';
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

/**
 * ISS-021: accept `subjects` (array) or the `subject` alias — one object, an
 * array, or a JSON string of either (the live agent sent a stringified object).
 */
export function resolveSubjects(
  subjects: SubjectRef[] | undefined,
  subject: SubjectRef | SubjectRef[] | string | undefined,
): { subjects: SubjectRef[] } | { error: string } {
  let candidate: unknown = subjects && subjects.length > 0 ? subjects : subject;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { error: '`subject` string is not valid JSON — pass subjects: [{ kind, ref }]' };
    }
  }
  const arr = Array.isArray(candidate) ? candidate : candidate != null ? [candidate] : [];
  const parsed = z.array(subjectSchema).min(1).safeParse(arr);
  if (!parsed.success) {
    return { error: '`subjects` is required: 1+ of { kind: person|place|group|topic, ref } (`subject` is accepted as an alias)' };
  }
  return { subjects: parsed.data };
}

const SOURCE_ALIASES: Record<string, ObservationSource> = {
  user: 'user_statement',
  'user-statement': 'user_statement',
  user_said: 'user_statement',
  stated: 'user_statement',
  observation: 'inference',
  observed: 'inference',
  inferred: 'inference',
  photo: 'inference',
  image: 'inference',
  media: 'inference',
  message: 'chat',
  im: 'chat',
  sms: 'chat',
  slack: 'chat',
  signal: 'chat',
  email: 'chat',
  agent: 'system',
  wa: 'whatsapp',
  tg: 'telegram',
};

/** ISS-021: map any source spelling onto the stored enum; report what changed. */
export function normalizeSource(raw: string | undefined): { source: ObservationSource; normalized?: string } {
  if (raw == null || !raw.trim()) return { source: 'inference', normalized: '(missing) → inference' };
  const key = raw.trim().toLowerCase();
  if ((sourceSchema.options as readonly string[]).includes(key)) {
    return { source: key as ObservationSource, ...(key !== raw ? { normalized: `${raw} → ${key}` } : {}) };
  }
  const mapped = SOURCE_ALIASES[key] ?? 'inference';
  return { source: mapped, normalized: `${raw} → ${mapped}` };
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
      'substrate for narratives, and it is cheap, append-only, and silent. Default to noting: if you',
      'can name a person, place, group, topic, mood, preference, or plan, record it rather than',
      'skipping — skipped detail is substrate lost for good. When in doubt, note it. Confidence: `high`',
      'for explicit user statements, `medium` for clear implication, `low` for inference. Sensitive=true',
      'for tender topics (mood, self-esteem, kids, marital, money worry); flag is informational, not gating.',
    ].join(' '),
    {
      // ISS-021: this is the tool the whole knowledge chain depends on, and the
      // live agent lost observations to shape slips (`subject` for `subjects`,
      // `content` for `text`, source:"observation"). Aliases are accepted and
      // `source` is normalized; anything normalized is echoed back.
      subjects: z.array(subjectSchema).min(1).optional().describe('1+ subjects this observation is about. Required unless `subject` is given.'),
      subject: z.union([subjectSchema, z.array(subjectSchema), z.string()]).optional().describe('Alias of subjects: one subject object, an array, or a JSON string of either.'),
      text: z.string().min(1).optional().describe('Your phrasing of what was observed. Required unless `content` is given.'),
      content: z.string().min(1).optional().describe('Alias of text'),
      source: z.string().optional().describe(`Where this observation came from: ${sourceSchema.options.join(' | ')}. Other spellings are normalized (e.g. "observation"/"photo" → inference, "user" → user_statement). Default: inference.`),
      source_id: z.string().optional().describe('ID of the source record (chat message id, journal id, etc.)'),
      source_excerpt: z.string().optional().describe('The actual line that triggered this'),
      confidence: confidenceSchema.optional().describe('Default medium'),
      mood: z.string().optional().describe('Free-text mood note'),
      sensitive: z.boolean().optional().describe('Default false. Tender topics → true'),
      observed_at: z.string().optional().describe('ISO 8601. Defaults to now'),
    },
    async (params) => {
      const userId = getUserId();

      const resolvedSubjects = resolveSubjects(params.subjects, params.subject);
      if ('error' in resolvedSubjects) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: resolvedSubjects.error }) }],
          isError: true,
        };
      }
      const subjects: SubjectRef[] = resolvedSubjects.subjects;

      const text = params.text ?? params.content;
      if (!text || !text.trim()) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: '`text` is required (`content` is accepted as an alias)' }) }],
          isError: true,
        };
      }

      const { source, normalized: sourceNormalized } = normalizeSource(params.source);
      const normalized: Record<string, unknown> = {};
      if (sourceNormalized) normalized.source = sourceNormalized;
      if (params.text == null && params.content != null) normalized.text = 'content';
      if (params.subjects == null && params.subject != null) normalized.subjects = 'subject';
      if (Object.keys(normalized).length > 0) {
        logger.warn('[note_observation] normalized input shape', { userId, normalized });
      }

      const v = await validateSubjects(subjects, { personRepo, placeRepo, userId });
      if (!v.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: v.message }) }],
          isError: true,
        };
      }

      // ISS-032: a fresh topic slug that already has a narrative under another
      // slug is ALSO tagged with that narrative's subject, so the existing story
      // refreshes instead of a duplicate queueing as a "new subject". Reported
      // back as `linked` so the agent learns the canonical ref.
      const linked: Array<{ from: string; to: string; title: string; shared: string[] }> = [];
      for (const s of subjects.filter((x) => x.kind === 'topic')) {
        try {
          if (await narrativeRepo.getBySubject(userId, s)) continue;
          const words = significantWords(s.ref);
          if (words.length < 2) continue;
          const { items } = await narrativeRepo.list(userId, { status: 'active', subjectKind: 'topic', query: words.join(' '), limit: 5 });
          const pick = chooseLinkedNarrative(s.ref, items);
          if (pick && !subjects.some((x) => x.kind === pick.narrative.subject.kind && x.ref === pick.narrative.subject.ref)) {
            subjects.push({ kind: pick.narrative.subject.kind, ref: pick.narrative.subject.ref });
            linked.push({ from: s.ref, to: pick.narrative.subject.ref, title: pick.narrative.title, shared: pick.shared });
          }
        } catch (err) {
          logger.warn('[note_observation] subject link lookup failed', { userId, ref: s.ref, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (linked.length > 0) logger.info('[note_observation] linked new topic slug(s) to existing narratives', { userId, linked });

      const obs = await observationRepo.create(userId, {
        subjects,
        text,
        source,
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
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            observation: obs,
            ...(Object.keys(normalized).length > 0 ? { normalized } : {}),
            ...(linked.length > 0 ? { linked, hint: `Also tagged to the existing narrative subject(s) ${linked.map((l) => `\`${l.to}\``).join(', ')} — use that ref next time instead of inventing a new slug.` } : {}),
          }),
        }],
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
      'The result is capped at ~20 KB (cut at observation boundaries, newest kept): when more exists it carries',
      'truncated:true + next_cursor + hint — narrow with since / query / fewer subjects, lower limit, or pass cursor to continue.',
    ].join(' '),
    {
      subjects: z.array(subjectSchema).optional().describe('Subjects to recall about. At least one of subjects/query required'),
      query: z.string().optional().describe('Free-text search across observation text'),
      since: z.string().optional().describe('ISO 8601 — only observations on/after this date'),
      limit: z.number().min(1).max(200).optional().describe('Default 30. The ~20 KB result cap applies on top of this.'),
      include_narrative: z.boolean().optional().describe('Default true. Include rolled-up narrative summary if one exists'),
      cursor: z.string().optional().describe('Opaque continuation cursor from a previous truncated response (next_cursor). Omit for the first page.'),
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
      let offset: number;
      try {
        offset = resolveOffset({ cursor: params.cursor });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }
      const limit = params.limit ?? 30;

      const subjects: SubjectRef[] = params.subjects ?? [];
      // ISS-019: one probe row past the page tells us whether more exists.
      const fetched = await observationRepo.recall(userId, {
        subjects: subjects.length > 0 ? subjects : undefined,
        query: params.query,
        since: params.since,
        limit: limit + 1,
        ...(offset > 0 ? { offset } : {}),
      });
      const hasMore = fetched.length > limit;

      const includeNarrative = params.include_narrative ?? true;
      const narratives = [];
      if (includeNarrative) {
        for (const s of subjects) {
          const n = await narrativeRepo.getBySubject(userId, s);
          if (n) narratives.push(n);
        }
      }

      const page = capItems(hasMore ? fetched.slice(0, limit) : fetched, {
        offset,
        hasMore,
        reserve: JSON.stringify(narratives).length + 400,
        hint: 'Narrow with `since`, `query`, or fewer `subjects`.',
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ narratives, observations: page.items, ...pageFields(page) }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_narratives — for skills + dashboard
  // -------------------------------------------------------------------------
  server.tool(
    'list_narratives',
    'List narratives. Use for review skills and dashboard. Default returns active narratives sorted by recency. Pass sort="relevance" for the "what matters now" ordering (recency-dominant, boosted by active status / open threads / volume). ' +
      'The result is capped at ~20 KB (cut at narrative boundaries): when more exists it carries truncated:true + next_cursor + hint — ' +
      'narrow with query / subject_kind / status / stale_for_days, lower limit, or pass cursor to continue.',
    {
      status: statusSchema.optional().describe('active / dormant / closed. Default active'),
      subject_kind: subjectKindSchema.optional().describe('Filter by subject kind'),
      participant_id: z.string().optional().describe('Person ID involved in the narrative'),
      place_id: z.string().optional().describe('Place ID involved in the narrative'),
      stale_for_days: z.number().min(1).optional().describe('Active narratives untouched for N+ days'),
      query: z.string().optional().describe('Free-text search title + summary + open threads'),
      sort: z.enum(['relevance', 'recency', 'active']).optional().describe('Ordering. Default recency (newest activity first). "active" = most observations in the window first. "relevance" = currently-relevant composite score (recency + volume + status).'),
      limit: z.number().min(1).max(200).optional().describe('Default 50. The ~20 KB result cap applies on top of this.'),
      offset: z.number().min(0).optional().describe('Pagination offset (legacy; `cursor` wins when both are given)'),
      cursor: z.string().optional().describe('Opaque continuation cursor from a previous truncated response (next_cursor). Omit for the first page.'),
      max_chars: z.number().min(1000).max(500000).optional().describe('Programmatic consumers only (gateway/dashboard): raise the result cap. Agents must NOT use this — narrow the query or follow cursor instead.'),
    },
    async (params) => {
      const userId = getUserId();
      let offset: number;
      try {
        offset = resolveOffset({ cursor: params.cursor, offset: params.offset });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }
      const result = await narrativeRepo.list(userId, {
        status: (params.status ?? 'active') as NarrativeStatus,
        subjectKind: params.subject_kind,
        participantId: params.participant_id,
        placeId: params.place_id,
        staleForDays: params.stale_for_days,
        query: params.query,
        sort: params.sort,
        limit: params.limit,
        offset,
      });
      const page = capItems(result.items, {
        offset,
        hasMore: offset + result.items.length < result.total,
        cap: resolveCap(params.max_chars),
        hint: 'Narrow with `query`, `subject_kind`, `status` or `stale_for_days`.',
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ narratives: page.items, total: result.total, ...pageFields(page) }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // get_narrative — full retrieval for one subject
  // -------------------------------------------------------------------------
  server.tool(
    'get_narrative',
    'Full retrieval for one subject — narrative summary + recent observations timeline. ' +
      'The result is capped at ~20 KB (the narrative always comes whole; observations are cut at item boundaries, newest kept): ' +
      'when more exists it carries truncated:true + next_cursor + hint — lower observation_limit, or pass cursor to continue.',
    {
      subject: subjectSchema.describe('The subject to load'),
      observation_limit: z.number().min(1).max(500).optional().describe('Default 30, most recent first. The ~20 KB result cap applies on top of this.'),
      cursor: z.string().optional().describe('Opaque continuation cursor from a previous truncated response (next_cursor). Omit for the first page.'),
      max_chars: z.number().min(1000).max(500000).optional().describe('Programmatic consumers only (gateway/dashboard): raise the result cap. Agents must NOT use this — lower observation_limit or follow cursor instead.'),
    },
    async (params) => {
      const userId = getUserId();
      const subject: SubjectRef = params.subject;
      let offset: number;
      try {
        offset = resolveOffset({ cursor: params.cursor });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }
      const limit = params.observation_limit ?? 30;

      const narrative = await narrativeRepo.getBySubject(userId, subject);
      // ISS-019: one probe row past the page tells us whether more exists.
      const fetched = await observationRepo.recall(userId, {
        subjects: [subject],
        limit: limit + 1,
        ...(offset > 0 ? { offset } : {}),
      });
      const hasMore = fetched.length > limit;

      if (!narrative && fetched.length === 0 && offset === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ narrative: null, observations: [], note: 'No narrative or observations exist for this subject yet.' }),
          }],
        };
      }

      const page = capItems(hasMore ? fetched.slice(0, limit) : fetched, {
        offset,
        hasMore,
        cap: resolveCap(params.max_chars),
        reserve: JSON.stringify(narrative ?? null).length + 400,
        hint: 'Lower `observation_limit`.',
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ narrative, observations: page.items, ...pageFields(page) }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // get_narrative_connections — the connection map for one narrative
  // -------------------------------------------------------------------------
  server.tool(
    'get_narrative_connections',
    [
      'Map how a narrative connects to the rest of the world: its participant/place',
      'entity spokes and the OTHER narratives it links to — via shared participants,',
      'shared places, or subjects co-tagged on the same observations. Derived live',
      '(no stored graph). Use to answer "what else is tied to this thread?" or to power',
      'a connections view. Entity refs are resolved to display names where possible.',
    ].join(' '),
    {
      subject: subjectSchema.describe('The narrative to map connections for'),
    },
    async (params) => {
      const userId = getUserId();
      const conn = await narrativeRepo.getConnections(userId, params.subject);

      // Resolve person/place refs to display names (best-effort; ref kept on failure).
      const entities = await Promise.all(
        conn.entities.map(async (e) => {
          try {
            const name =
              e.kind === 'person'
                ? (await personRepo.get(userId, e.ref))?.name
                : (await placeRepo.get(userId, e.ref))?.name;
            return { ...e, name: name ?? undefined };
          } catch {
            return e;
          }
        }),
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ subject: conn.subject, entities, related: conn.related }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_narrative_work — the driver query for the async maintenance loop
  // -------------------------------------------------------------------------
  server.tool(
    'list_narrative_work',
    [
      'Return the narrative consolidation work-list: which existing narratives to REFRESH',
      '(active, with new activity since their last summary) and which subjects to CREATE',
      '(enough recent observations but no narrative yet). This is the entry point for the',
      'background narrative-maintenance loop — call it first, then consolidate_narrative +',
      'upsert_narrative each item. Activity is measured against the LIVE latest observation,',
      'not the stale stored timestamp. Defaults are sensitive (promote_threshold 1).',
    ].join(' '),
    {
      window_days: z.number().int().positive().optional().describe('Only consider observations newer than this many days. Default 14.'),
      promote_threshold: z.number().int().positive().optional().describe('Min observations for a no-narrative subject to be promoted to CREATE. Default 1.'),
      debounce_minutes: z.number().int().positive().optional().describe('Skip refreshing a narrative consolidated within this many minutes. Default 45.'),
      max: z.number().int().positive().optional().describe('Safety cap per side (stale, orphans). Default 25.'),
    },
    async (params) => {
      const userId = getUserId();
      const work = await narrativeRepo.selectConsolidationWork(userId, {
        windowDays: params.window_days,
        promoteThreshold: params.promote_threshold,
        debounceMinutes: params.debounce_minutes,
        max: params.max,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            refresh_count: work.stale.length,
            create_count: work.orphans.length,
            refresh: work.stale.map((s) => ({
              subject: s.subject,
              title: s.title,
              last_observed_at: s.lastObservedAt,
              last_consolidated_at: s.lastConsolidatedAt,
            })),
            create: work.orphans.map((o) => ({
              subject: o.subject,
              observation_count: o.count,
              sample: (o.sample || '').slice(0, 160),
            })),
          }),
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
