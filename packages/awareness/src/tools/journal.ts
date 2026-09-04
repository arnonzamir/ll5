import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logAudit, formatTime, sessionTimezone, capItems, pageFields, resolveOffset } from '@ll5/shared';
import { logger } from '../utils/logger.js';

const INDEX = 'll5_agent_journal';
const USER_MODEL_INDEX = 'll5_agent_user_model';
const USER_MODEL_HISTORY_INDEX = 'll5_agent_user_model_history';

export function registerJournalTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'write_journal',
    'Write a micro-journal entry that persists across sessions — observations, feedback, decisions, context, thoughts, or commitments. Default to writing: entries are cheap, append-only, and silent, and uncaptured context is lost permanently. Recording is the expectation after any meaningful event, not a judgment call — skip only a purely mechanical exchange that reveals nothing. When in doubt, write.',
    {
      type: z.enum(['observation', 'feedback', 'decision', 'context', 'thought', 'commitment']).describe('Category of the journal entry. Exactly one of observation | feedback | decision | context | thought | commitment — NOT a signal value ("confirmed" is a `signal`, not a type).'),
      topic: z.string().describe('Short topic or subject line'),
      content: z.string().describe('The journal entry content'),
      // ISS-021: the consolidate skill writes signal:"consolidated" and the
      // backfill skill signal:"completed"; both were rejected by the enum.
      signal: z.enum(['correction', 'pattern', 'mood', 'insight', 'confirmed', 'commitment', 'consolidated', 'completed']).optional().describe('Optional signal tag for the entry (correction | pattern | mood | insight | confirmed | commitment | consolidated | completed)'),
      session_id: z.string().optional().describe('Optional session identifier'),
    },
    async (params) => {
      const userId = getUserId();
      const now = new Date().toISOString();

      const doc = {
        user_id: userId,
        type: params.type,
        topic: params.topic,
        content: params.content,
        signal: params.signal ?? null,
        status: 'open',
        session_id: params.session_id ?? null,
        created_at: now,
        updated_at: now,
      };

      const result = await esClient.index({
        index: INDEX,
        document: doc,
        refresh: 'wait_for',
      });

      logAudit({
        user_id: userId,
        source: 'awareness',
        action: 'create',
        entity_type: 'journal',
        entity_id: result._id,
        summary: `Created journal entry: ${params.topic}`,
        metadata: { type: params.type, signal: params.signal },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: result._id,
              type: params.type,
              topic: params.topic,
              status: 'open',
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'read_journal',
    'Read journal entries. Defaults to open entries, sorted by newest first. ' +
      'The result is capped at ~20 KB (truncated at entry boundaries, newest kept); when more exists the ' +
      'response carries truncated:true + next_cursor + hint — narrow with since / topic / type / status, ' +
      'lower limit, or pass cursor to continue from where the page stopped.',
    {
      status: z.string().optional().describe('Filter by status (default: open)'),
      type: z.string().optional().describe('Filter by entry type'),
      topic: z.string().optional().describe('Text search on topic field'),
      limit: z.number().min(1).max(200).optional().describe('Max entries to return (default: 20). The ~20 KB result cap applies on top of this.'),
      since: z.string().optional().describe('Only return entries created after this ISO date'),
      cursor: z.string().optional().describe('Opaque continuation cursor from a previous truncated response (next_cursor). Omit for the first page.'),
    },
    async (params) => {
      const userId = getUserId();
      let offset: number;
      try {
        offset = resolveOffset({ cursor: params.cursor });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }
      const must: Record<string, unknown>[] = [
        { term: { user_id: userId } },
        { term: { status: params.status ?? 'open' } },
      ];

      if (params.type) {
        must.push({ term: { type: params.type } });
      }

      if (params.topic) {
        must.push({ match: { topic: params.topic } });
      }

      if (params.since) {
        must.push({ range: { created_at: { gte: params.since } } });
      }

      const limit = params.limit ?? 20;
      const result = await esClient.search({
        index: INDEX,
        size: limit,
        from: offset,
        track_total_hits: true,
        sort: [{ created_at: { order: 'desc' } }],
        query: { bool: { must } },
      });

      const tz = sessionTimezone();
      const allEntries = result.hits.hits.map((hit) => {
        const src = hit._source as Record<string, unknown>;
        const created = src.created_at as string | undefined;
        const updated = src.updated_at as string | undefined;
        return {
          id: hit._id,
          ...src,
          created_at_local: created ? formatTime(created, tz).local : null,
          updated_at_local: updated ? formatTime(updated, tz).local : null,
        };
      });

      // ISS-019: bound the payload. `matched` is the true ES total; `total` stays
      // the returned count (its pre-cap meaning) so small results are unchanged.
      const rawTotal = result.hits.total;
      const matched = typeof rawTotal === 'number' ? rawTotal : rawTotal?.value ?? allEntries.length;
      const page = capItems(allEntries, {
        offset,
        hasMore: offset + allEntries.length < matched,
        hint: 'Narrow with `since`, `topic`, `type` or `status`.',
      });
      const entries = page.items;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              entries,
              total: entries.length,
              tz,
              ...(page.truncated ? { matched } : {}),
              ...pageFields(page),
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'resolve_journal',
    'Mark journal entries as resolved. Provide either a specific entry_id or a topic to resolve all matching open entries.',
    {
      entry_id: z.string().optional().describe('Specific entry ID to resolve'),
      topic: z.string().optional().describe('Resolve all open entries matching this topic keyword'),
    },
    async (params) => {
      const userId = getUserId();
      const now = new Date().toISOString();
      let resolvedCount = 0;

      if (params.entry_id) {
        // Verify ownership before mutating: a raw update by _id would let one
        // user resolve another user's journal entry.
        let ownerUserId: string | undefined;
        try {
          const existing = await esClient.get({ index: INDEX, id: params.entry_id });
          ownerUserId = (existing._source as Record<string, unknown> | undefined)?.user_id as
            | string
            | undefined;
        } catch {
          ownerUserId = undefined;
        }

        if (ownerUserId !== userId) {
          logger.warn('cross_user_access_denied', {
            actor_user_id: userId,
            owner_user_id: ownerUserId ?? null,
            resource: 'journal',
            id: params.entry_id,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ resolved_count: 0 }) }],
          };
        }

        await esClient.update({
          index: INDEX,
          id: params.entry_id,
          doc: { status: 'resolved', updated_at: now },
          refresh: 'wait_for',
        });
        resolvedCount = 1;
      } else if (params.topic) {
        const result = await esClient.updateByQuery({
          index: INDEX,
          refresh: true,
          query: {
            bool: {
              must: [
                { term: { user_id: userId } },
                { term: { status: 'open' } },
                { term: { 'topic.keyword': params.topic } },
              ],
            },
          },
          script: {
            source: "ctx._source.status = 'resolved'; ctx._source.updated_at = params.now;",
            lang: 'painless',
            params: { now },
          },
        });
        resolvedCount = result.updated ?? 0;
      }

      logAudit({
        user_id: userId,
        source: 'awareness',
        action: 'update',
        entity_type: 'journal',
        entity_id: params.entry_id ?? `topic:${params.topic}`,
        summary: `Resolved ${resolvedCount} journal entry(s)`,
        metadata: { entry_id: params.entry_id, topic: params.topic, resolved_count: resolvedCount },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ resolved_count: resolvedCount }),
          },
        ],
      };
    },
  );

  server.tool(
    'read_user_model',
    'Read the persistent user model. Optionally load a single section (e.g. "communication", "relationships", "routines", "goals", "work", "active_context") or all sections at once.',
    {
      section: z.string().optional().describe('Section name to load. If omitted, loads all sections.'),
    },
    async (params) => {
      const userId = getUserId();

      if (params.section) {
        try {
          const result = await esClient.get({
            index: USER_MODEL_INDEX,
            id: `${userId}_${params.section}`,
          });
          const source = result._source as Record<string, unknown>;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  section: params.section,
                  content: source.content,
                  last_updated: source.last_updated,
                }),
              },
            ],
          };
        } catch (err: unknown) {
          const isNotFound =
            err instanceof Error &&
            'meta' in err &&
            (err as { meta?: { statusCode?: number } }).meta?.statusCode === 404;
          if (isNotFound) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ section: null }),
                },
              ],
            };
          }
          throw err;
        }
      }

      // Load all sections for this user
      const result = await esClient.search({
        index: USER_MODEL_INDEX,
        size: 20,
        query: { term: { user_id: userId } },
      });

      const sections = result.hits.hits.map((hit) => {
        const source = hit._source as Record<string, unknown>;
        return {
          section: source.section,
          content: source.content,
          last_updated: source.last_updated,
        };
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sections }),
          },
        ],
      };
    },
  );

  server.tool(
    'write_user_model',
    'Write or update a section of the persistent user model. Sections are topic-based (e.g. "communication", "relationships", "routines", "goals", "work", "active_context").',
    {
      section: z.string().describe('Section name (e.g. "communication", "relationships", "routines")'),
      content: z.record(z.unknown()).describe('Section content as a JSON object'),
    },
    async (params) => {
      const userId = getUserId();
      const now = new Date().toISOString();
      const docId = `${userId}_${params.section}`;

      // Snapshot current version to history before overwriting. A 404 on the get is
      // the first write of this section; any other failure is logged and reported
      // in the result (the live write still goes through — the model matters more
      // than its history). ISS-012: for 11 weeks every snapshot failed on the
      // history index's 1000-field mapping limit inside a bare `catch {}`.
      let createdAt = now;
      let snapshotWarning: string | undefined;
      try {
        const existing = await esClient.get<{ created_at?: string }>({ index: USER_MODEL_INDEX, id: docId });
        if (existing._source) {
          createdAt = existing._source.created_at ?? now;
          await esClient.index({
            index: USER_MODEL_HISTORY_INDEX,
            document: {
              ...(existing._source as Record<string, unknown>),
              archived_at: now,
              original_id: docId,
            },
          });
        }
      } catch (err) {
        if ((err as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('user_model_history_snapshot_failed', { section: params.section, error: message });
          snapshotWarning = `history snapshot failed, previous version NOT preserved: ${message}`;
        }
      }

      await esClient.index({
        index: USER_MODEL_INDEX,
        id: docId,
        document: {
          user_id: userId,
          section: params.section,
          content: params.content,
          last_updated: now,
          created_at: createdAt,
        },
        refresh: 'wait_for',
      });

      logAudit({
        user_id: userId,
        source: 'awareness',
        action: 'update',
        entity_type: 'user_model',
        entity_id: docId,
        summary: `Updated user model section: ${params.section}`,
        metadata: { section: params.section },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ section: params.section, updated: true, ...(snapshotWarning ? { warning: snapshotWarning } : {}) }),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_user_model_versions
  // ---------------------------------------------------------------------------
  server.tool(
    'list_user_model_versions',
    'List historical versions of a user model section. Shows when each version was archived.',
    {
      section: z.string().describe('Section name to list versions for'),
      limit: z.number().optional().describe('Max results. Default: 10'),
    },
    async (params) => {
      const userId = getUserId();

      const result = await esClient.search({
        index: USER_MODEL_HISTORY_INDEX,
        query: {
          bool: {
            filter: [
              { term: { user_id: userId } },
              { term: { section: params.section } },
            ],
          },
        },
        size: params.limit ?? 10,
        sort: [{ archived_at: 'desc' }],
        _source: ['section', 'last_updated', 'archived_at'],
      });

      const versions = result.hits.hits.map((hit) => ({
        id: hit._id,
        ...(hit._source as Record<string, unknown>),
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ versions, count: versions.length }) }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // get_user_model_version
  // ---------------------------------------------------------------------------
  server.tool(
    'get_user_model_version',
    'Get a specific historical version of a user model section by its history ID.',
    {
      version_id: z.string().describe('The history document ID from list_user_model_versions'),
    },
    async (params) => {
      const userId = getUserId();

      try {
        const doc = await esClient.get({ index: USER_MODEL_HISTORY_INDEX, id: params.version_id });
        const source = doc._source as Record<string, unknown>;
        if (source.user_id !== userId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not found' }) }], isError: true };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ section: source.section, content: source.content, last_updated: source.last_updated, archived_at: source.archived_at }) }],
        };
      } catch {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Version not found' }) }], isError: true };
      }
    },
  );
}
