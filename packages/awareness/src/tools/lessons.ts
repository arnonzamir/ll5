import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logAudit } from '@ll5/shared';
import { logger } from '../utils/logger.js';

// Governed agent "lessons" store — operational/world knowledge the agent learns about
// operating itself and its tools. GLOBAL (scope=world, shared across tenants — a living
// runbook), reconciled on write so contradictions can never silently coexist (the failure
// that drove this: two opposite create_tickler-timezone beliefs held at once), and recalled
// intentionally via hooks. User-specific knowledge does NOT live here — it routes to the
// user_model (write_user_model). Versioned via the *_history index.
const LESSONS_INDEX = 'll5_agent_lessons';
const LESSONS_HISTORY_INDEX = 'll5_agent_lessons_history';
const USER_MODEL_INDEX = 'll5_agent_user_model';
const USER_MODEL_HISTORY_INDEX = 'll5_agent_user_model_history';
const WORLD_SCOPE = 'world';

// Merge/conflict decisions use DETERMINISTIC claim token-overlap (overlap coefficient),
// NOT the BM25 score — BM25 is normalized against the top hit, so the top match is always
// ~1.0 and a score threshold would merge any two lessons. Overlap on significant claim
// tokens only fires for genuine restatements (e.g. two "create_tickler timezone" lessons),
// never for unrelated topics.
const MERGE_OVERLAP = 0.6;    // auto-merge in place (ingest) — essentially the same claim
const CONFLICT_OVERLAP = 0.4; // surface as a potential conflict to reconcile (upsert/review)

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'by', 'your',
  'you', 'it', 'that', 'this', 'be', 'as', 'at', 'not', 'no', 'my', 'if', 'when', 'use', 'do', 'its',
  'was', 'were', 'will', 'should', 'must', 'can', 'has', 'have', 'from', 'into', 'than', 'then',
]);
function sigTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}
/** Overlap coefficient on significant tokens: |A∩B| / min(|A|,|B|). 1.0 = one contains the other. */
function claimOverlap(a: string, b: string): number {
  const A = sigTokens(a);
  const B = sigTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

interface LessonSource {
  scope: string;
  claim: string;
  trigger: string;
  detail: string | null;
  durability: 'durable' | 'provisional';
  status: 'active' | 'retired';
  falsification_test: string | null;
  depends_on: string | null;
  expires: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  source: string | null;
  author_user_id: string;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

function text(obj: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

/** Snapshot the current live doc into history before it is overwritten or retired. */
async function snapshot(esClient: Client, id: string, now: string): Promise<void> {
  try {
    const existing = await esClient.get<LessonSource>({ index: LESSONS_INDEX, id });
    if (existing._source) {
      await esClient.index({
        index: LESSONS_HISTORY_INDEX,
        document: { ...existing._source, archived_at: now, original_id: id },
      });
    }
  } catch (err) {
    // 404 = no existing doc, nothing to snapshot. Anything else is a real failure
    // and must not vanish (ISS-012: the user-model history died silently this way).
    if ((err as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) {
      logger.error('lesson_history_snapshot_failed', { id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** BM25 fuzzy search of ACTIVE world lessons, returning normalized 0..1 relevance. */
async function searchActive(
  esClient: Client,
  query: string,
  limit: number,
): Promise<{ id: string; score: number; source: LessonSource }[]> {
  const res = await esClient.search<LessonSource>({
    index: LESSONS_INDEX,
    size: limit,
    query: {
      bool: {
        filter: [{ term: { scope: WORLD_SCOPE } }, { term: { status: 'active' } }],
        must: query
          ? [{ multi_match: { query, fields: ['claim^2', 'trigger^1.5', 'detail'], fuzziness: 'AUTO' } }]
          : [{ match_all: {} }],
      },
    },
  });
  const hits = res.hits.hits;
  const max = hits.length > 0 ? (hits[0]._score ?? 1) : 1;
  return hits.map((h) => ({
    id: h._id as string,
    score: query && max > 0 ? Math.round(((h._score ?? 0) / max) * 100) / 100 : 1,
    source: h._source as LessonSource,
  }));
}

export function registerLessonTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  // ---------------------------------------------------------------------------
  // upsert_lesson — reconcile-on-write. The governance the native file store lacked:
  // a new lesson that contradicts/duplicates an existing one cannot be blind-inserted.
  // ---------------------------------------------------------------------------
  server.tool(
    'upsert_lesson',
    'Record an OPERATIONAL/world lesson — something learned about operating the system or its tools (e.g. "create_tickler due_time is the user\'s local effective timezone"). NOT for facts about a specific user (those go to write_user_model). Reconcile-on-write: if a near-duplicate or contradicting active lesson exists you MUST resolve it — pass supersede_id to replace that lesson, or force=true to insert as genuinely distinct. Without that, the write is blocked and the conflicts are returned so nothing contradictory can coexist.',
    {
      // ISS-021: claim/trigger/durability were all required; the agent sent a
      // single `content` body. `content` is accepted as an alias (claim = its first
      // line, detail = the rest), trigger defaults to the claim, durability to
      // durable. Applied defaults are echoed back as `defaults_applied`.
      claim: z.string().optional().describe('The lesson/belief, stated plainly and self-contained. Required unless `content` is given.'),
      content: z.string().optional().describe('Alias: a full lesson body. Its first line/sentence becomes `claim`, the whole text becomes `detail`.'),
      trigger: z.string().optional().describe('When this lesson is relevant — the recall key (e.g. "scheduling ticklers or calendar events"). Defaults to the claim.'),
      detail: z.string().optional().describe('Optional fuller body — the why and how-to-apply.'),
      durability: z
        .enum(['durable', 'provisional'])
        .optional()
        .describe('durable (default) = a standing truth; provisional = a workaround for a current bug/limitation (must carry a falsification_test and depends_on).'),
      falsification_test: z.string().optional().describe('Provisional only: the concrete check that, if it passes, retires this lesson.'),
      depends_on: z.string().optional().describe('Provisional only: the tool/code path this compensates for (so a deploy touching it flags re-verification).'),
      expires: z.string().optional().describe('Provisional only: optional ISO date after which this lesson should not be trusted.'),
      source: z.string().optional().describe('Provenance: why/how this was learned (incident, user feedback, session).'),
      supersede_id: z.string().optional().describe('Retire this existing lesson id and replace it with the new one (the reconcile action).'),
      force: z.boolean().optional().describe('Insert as a genuinely distinct lesson despite near-matches (use only when it truly does not contradict them).'),
    },
    async (rawParams) => {
      const userId = getUserId();
      const now = new Date().toISOString();

      // ISS-021: derive claim/trigger/durability when the agent sent a bare body.
      const defaultsApplied: Record<string, unknown> = {};
      let claim = rawParams.claim?.trim();
      let detail = rawParams.detail;
      if (!claim && rawParams.content?.trim()) {
        const body = rawParams.content.trim();
        const firstLine = body.split(/\r?\n/).find((l) => l.trim()) ?? body;
        claim = firstLine.replace(/^[\s#*>-]+|[\s*]+$/g, '').trim().slice(0, 300);
        detail = detail ?? body;
        defaultsApplied.claim = 'first line of content';
        if (!rawParams.detail) defaultsApplied.detail = 'content';
      }
      if (!claim) {
        return text({ ok: false, error: '`claim` is required (or pass `content`, whose first line becomes the claim).' });
      }
      const trigger = rawParams.trigger?.trim() || (defaultsApplied.trigger = 'claim', claim);
      const durability = rawParams.durability ?? (defaultsApplied.durability = 'durable', 'durable' as const);
      const params = { ...rawParams, claim, trigger, detail, durability };

      if (params.durability === 'provisional' && !params.falsification_test) {
        return text({
          ok: false,
          error: 'A provisional lesson must include a falsification_test (the check that retires it).',
        });
      }

      // Find near matches via BM25, then decide conflicts by deterministic claim overlap.
      const near = await searchActive(esClient, `${params.claim} ${params.trigger}`, 8);
      const conflicts = near
        .filter((m) => m.id !== params.supersede_id && claimOverlap(params.claim, m.source.claim) >= CONFLICT_OVERLAP);

      // Reconcile step: retire the superseded lesson (if any).
      let supersededClaim: string | null = null;
      if (params.supersede_id) {
        try {
          const old = await esClient.get<LessonSource>({ index: LESSONS_INDEX, id: params.supersede_id });
          supersededClaim = old._source?.claim ?? null;
          await snapshot(esClient, params.supersede_id, now);
          await esClient.update({
            index: LESSONS_INDEX,
            id: params.supersede_id,
            doc: { status: 'retired', retired_at: now, updated_at: now },
            refresh: 'wait_for',
          });
        } catch {
          return text({ ok: false, error: `supersede_id ${params.supersede_id} not found.` });
        }
      }

      // Hard-block: unresolved contradictions and not forced → refuse, return conflicts.
      if (conflicts.length > 0 && !params.force && !params.supersede_id) {
        return text({
          ok: false,
          needs_reconcile: true,
          message:
            'This lesson is close to existing active lesson(s). Resolve before writing: pass supersede_id to replace one, or force=true if it is genuinely distinct.',
          conflicts: conflicts.map((c) => ({
            id: c.id,
            relevance: c.score,
            claim: c.source.claim,
            durability: c.source.durability,
          })),
        });
      }

      const doc: LessonSource = {
        scope: WORLD_SCOPE,
        claim: params.claim,
        trigger: params.trigger,
        detail: params.detail ?? null,
        durability: params.durability,
        status: 'active',
        falsification_test: params.falsification_test ?? null,
        depends_on: params.depends_on ?? null,
        expires: params.expires ?? null,
        supersedes: params.supersede_id ?? null,
        superseded_by: null,
        source: params.source ?? null,
        author_user_id: userId,
        created_at: now,
        updated_at: now,
        retired_at: null,
      };

      const result = await esClient.index({ index: LESSONS_INDEX, document: doc, refresh: 'wait_for' });

      // Backlink the superseded lesson to its replacement.
      if (params.supersede_id) {
        await esClient.update({
          index: LESSONS_INDEX,
          id: params.supersede_id,
          doc: { superseded_by: result._id },
          refresh: 'wait_for',
        }).catch(() => {});
      }

      logAudit({
        user_id: userId,
        source: 'awareness',
        action: params.supersede_id ? 'update' : 'create',
        entity_type: 'lesson',
        entity_id: result._id,
        summary: `Lesson: ${params.claim.slice(0, 80)}`,
        metadata: { durability: params.durability, supersedes: params.supersede_id ?? null },
      });

      return text({
        ok: true,
        id: result._id,
        durability: params.durability,
        superseded: params.supersede_id ? { id: params.supersede_id, claim: supersededClaim } : null,
        forced_over_conflicts: params.force ? conflicts.map((c) => c.id) : [],
        ...(Object.keys(defaultsApplied).length > 0 ? { defaults_applied: defaultsApplied } : {}),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // recall_lessons — intentional recall. Hooks call this to inject relevant lessons.
  // ---------------------------------------------------------------------------
  server.tool(
    'recall_lessons',
    'Recall active operational/world lessons relevant to a task or tool (the governed replacement for native memory recall). Provisional lessons come back flagged with their falsification_test so they are verified before being trusted.',
    {
      query: z.string().describe('Task/tool context to match against lesson triggers (e.g. "scheduling a tickler").'),
      limit: z.number().optional().describe('Max lessons to return (default 6).'),
    },
    async (params) => {
      const matches = await searchActive(esClient, params.query, params.limit ?? 6);
      return text({
        lessons: matches.map((m) => ({
          id: m.id,
          relevance: m.score,
          claim: m.source.claim,
          trigger: m.source.trigger,
          detail: m.source.detail ?? null,
          durability: m.source.durability,
          verify_before_trust: m.source.durability === 'provisional' ? (m.source.falsification_test ?? null) : null,
        })),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // list_lessons — full listing for the dashboard / audits.
  // ---------------------------------------------------------------------------
  server.tool(
    'list_lessons',
    'List operational/world lessons (for review or the dashboard). Defaults to active lessons.',
    {
      status: z.enum(['active', 'retired', 'all']).optional().describe('Filter by status (default active).'),
      limit: z.number().optional().describe('Max lessons (default 100).'),
    },
    async (params) => {
      const status = params.status ?? 'active';
      const filter: Record<string, unknown>[] = [{ term: { scope: WORLD_SCOPE } }];
      if (status !== 'all') filter.push({ term: { status } });
      const res = await esClient.search<LessonSource>({
        index: LESSONS_INDEX,
        size: params.limit ?? 100,
        query: { bool: { filter } },
        sort: [{ updated_at: 'desc' }],
      });
      return text({
        lessons: res.hits.hits.map((h) => ({ id: h._id, ...(h._source as LessonSource) })),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // retire_lesson — explicit retirement (e.g. a provisional lesson's test passed).
  // ---------------------------------------------------------------------------
  server.tool(
    'retire_lesson',
    'Retire an operational/world lesson that is no longer true (e.g. a provisional workaround whose bug is fixed). Snapshots it to history first.',
    {
      id: z.string().describe('The lesson id to retire.'),
      reason: z.string().optional().describe('Why it is being retired (recorded in the audit log).'),
    },
    async (params) => {
      const userId = getUserId();
      const now = new Date().toISOString();
      try {
        await snapshot(esClient, params.id, now);
        await esClient.update({
          index: LESSONS_INDEX,
          id: params.id,
          doc: { status: 'retired', retired_at: now, updated_at: now },
          refresh: 'wait_for',
        });
      } catch {
        return text({ ok: false, error: `Lesson ${params.id} not found.` });
      }
      logAudit({
        user_id: userId,
        source: 'awareness',
        action: 'delete',
        entity_type: 'lesson',
        entity_id: params.id,
        summary: `Retired lesson${params.reason ? `: ${params.reason}` : ''}`,
        metadata: { reason: params.reason ?? null },
      });
      return text({ ok: true, id: params.id, retired: true });
    },
  );

  // ---------------------------------------------------------------------------
  // ingest_memory — the AUTOMATIC entry the PreToolUse hook calls when it intercepts
  // a native memory-file write. Classifies world-vs-user and routes transparently so
  // the agent's natural "save this" behavior is governed without a follow-up call:
  //   world → lessons store (auto-merge a very strong match in place; else insert)
  //   user  → appended into the user_model "learned_notes" section (no clobber)
  // ---------------------------------------------------------------------------
  server.tool(
    'ingest_memory',
    'INTERNAL (hook use): ingest a raw intercepted memory-file write, classify it as world (operational) or user (about the specific user), and route it to the governed store. World lessons go to the lessons runbook (auto-merging a near-duplicate in place); user knowledge is appended to the user_model. Returns what it did so the hook can tell the agent.',
    {
      raw_content: z.string().describe('The full markdown the agent tried to write (frontmatter + body).'),
      file_path: z.string().optional().describe('The intercepted path (provenance only).'),
    },
    async (params) => {
      const userId = getUserId();
      const now = new Date().toISOString();
      const fm = parseFrontmatter(params.raw_content);
      const scope = classifyScope(fm.name, fm.description, fm.body, fm.type);
      const provenance = `intercepted native memory${params.file_path ? ` (${params.file_path})` : ''}`;

      if (scope === 'user') {
        // Append into the user_model "learned_notes" section (read-merge-write, snapshotted).
        const section = 'learned_notes';
        const docId = `${userId}_${section}`;
        let notes: unknown[] = [];
        try {
          const existing = await esClient.get<{ content?: { notes?: unknown[] } }>({ index: USER_MODEL_INDEX, id: docId });
          notes = existing._source?.content?.notes ?? [];
          if (existing._source) {
            await esClient.index({
              index: USER_MODEL_HISTORY_INDEX,
              document: { ...(existing._source as Record<string, unknown>), archived_at: now, original_id: docId },
            });
          }
        } catch (err) {
          // 404 = first note, no snapshot. Any other failure on the GET must abort:
          // proceeding with notes=[] would overwrite every learned note with this
          // one (ISS-012 follow-up — the old bare catch did exactly that).
          if ((err as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error('user_model_learned_notes_snapshot_failed', { error: message });
            if (notes.length === 0) throw new Error(`learned_notes read/snapshot failed, refusing to overwrite: ${message}`);
          }
        }
        const note = { note: fm.name || fm.body.slice(0, 200), detail: fm.description || null, source: provenance, at: now };
        notes.push(note);
        await esClient.index({
          index: USER_MODEL_INDEX,
          id: docId,
          document: { user_id: userId, section, content: { notes }, last_updated: now, created_at: now },
          refresh: 'wait_for',
        });
        logAudit({
          user_id: userId, source: 'awareness', action: 'update', entity_type: 'user_model',
          entity_id: docId, summary: `Appended learned note: ${(fm.name || fm.body).slice(0, 60)}`, metadata: { via: 'ingest_memory' },
        });
        return text({ ok: true, scope: 'user', action: 'appended', section, note_count: notes.length });
      }

      // world → lessons store. claim = title; detail = the body (the why/how-to-apply);
      // trigger = the recall key (native description). The body is preserved + searchable.
      const claim = fm.name || fm.body.split('\n').find((l) => l.trim())?.trim() || fm.description || 'unspecified lesson';
      const trigger = fm.description || fm.name || claim;
      const detail = fm.body || null;
      const near = await searchActive(esClient, `${claim} ${trigger} ${detail ?? ''}`, 8);
      // Auto-merge only a genuine restatement (high claim overlap), never just the BM25 top hit.
      const strong = near
        .map((m) => ({ m, ov: claimOverlap(claim, m.source.claim) }))
        .filter((x) => x.ov >= MERGE_OVERLAP)
        .sort((a, b) => b.ov - a.ov)[0]?.m;

      if (strong) {
        // Same lesson evolving → update in place; old version preserved in history.
        await snapshot(esClient, strong.id, now);
        await esClient.update({
          index: LESSONS_INDEX,
          id: strong.id,
          doc: { claim, trigger, detail, source: provenance, updated_at: now, status: 'active' },
          refresh: 'wait_for',
        });
        logAudit({
          user_id: userId, source: 'awareness', action: 'update', entity_type: 'lesson',
          entity_id: strong.id, summary: `Lesson updated in place: ${claim.slice(0, 60)}`, metadata: { via: 'ingest_memory', prior_relevance: strong.score },
        });
        return text({ ok: true, scope: 'world', action: 'updated_in_place', id: strong.id, claim });
      }

      const doc: LessonSource = {
        scope: WORLD_SCOPE, claim, trigger, detail, durability: 'durable', status: 'active',
        falsification_test: null, depends_on: null, expires: null, supersedes: null, superseded_by: null,
        source: provenance, author_user_id: userId, created_at: now, updated_at: now, retired_at: null,
      };
      const result = await esClient.index({ index: LESSONS_INDEX, document: doc, refresh: 'wait_for' });
      logAudit({
        user_id: userId, source: 'awareness', action: 'create', entity_type: 'lesson',
        entity_id: result._id, summary: `Lesson created: ${claim.slice(0, 60)}`, metadata: { via: 'ingest_memory' },
      });
      const softConflicts = near
        .filter((m) => claimOverlap(claim, m.source.claim) >= CONFLICT_OVERLAP)
        .map((m) => ({ id: m.id, claim: m.source.claim }));
      return text({ ok: true, scope: 'world', action: 'created', id: result._id, claim, review_possible_conflicts: softConflicts });
    },
  );

  logger.debug('[lessons] registered upsert_lesson, recall_lessons, list_lessons, retire_lesson, ingest_memory');
}

/** Parse the native auto-memory frontmatter (name/description/metadata.type) + body. */
function parseFrontmatter(raw: string): { name: string; description: string; type: string; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: '', description: '', type: '', body: raw.trim() };
  const fmBlock = m[1];
  const body = m[2].trim();
  const field = (k: string): string => (fmBlock.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? '').trim();
  // type may be top-level or nested under metadata:
  const type = (fmBlock.match(/type:\s*([\w-]+)/)?.[1] ?? '').trim();
  return { name: field('name'), description: field('description'), type, body };
}

/**
 * Classify an intercepted memory as 'world' (operational/system knowledge — global runbook)
 * vs 'user' (about the specific user — routes to the user_model). Heuristic: frontmatter
 * type=user is decisive; otherwise weigh operational vs personal markers in the text.
 */
function classifyScope(name: string, description: string, body: string, fmType: string): 'world' | 'user' {
  if (fmType === 'user') return 'user';
  const hay = `${name} ${description} ${body}`.toLowerCase();
  // Personal markers: a fact/preference about the specific user (→ user_model).
  const personalHints = [
    'arnon', ' he ', ' his ', ' him ', ' she ', ' her ', 'ritalin', ' meds', 'medication', 'wife',
    ' son', 'daughter', 'family', 'rotem', 'itamar', 'birthday', 'commute', 'army', 'his ', 'health',
  ];
  // Operating markers: a rule/method about how to do the job (→ world runbook). The native
  // "feedback" type is operating guidance, so it counts toward world.
  const operatingHints = [
    'create_tickler', 'tickler', 'mcp', 'elasticsearch', 'timezone', 'utc', 'deploy', 'gateway',
    'endpoint', 'hook', 'scheduler', 'webhook', 'tool', 'bug', 'error', 'auth', 'container', 'never',
    "don't", 'always', 'confirm', 'verify', 'do not', 'avoid', 'image', 'screenshot', 'location',
    'place', 'whatsapp', 'message', 'contact', 'send', 'relay', 'precision', 'tracking',
  ];
  const personal = personalHints.filter((h) => hay.includes(h)).length + (fmType === 'feedback' ? 0 : 0);
  const operating = operatingHints.filter((h) => hay.includes(h)).length + (fmType === 'feedback' ? 1 : 0);
  // Route to user ONLY when personal markers clearly dominate; otherwise world. Mis-filing a
  // world lesson into the runbook is reviewable; polluting the user_model is worse.
  if (personal >= 2 && personal > operating) return 'user';
  return 'world';
}

