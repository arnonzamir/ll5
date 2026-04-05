import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logAudit } from '@ll5/shared';

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
    'Write a micro-journal entry that persists across sessions. Use for observations, feedback, decisions, context, thoughts, or commitments.',
    {
      type: z.enum(['observation', 'feedback', 'decision', 'context', 'thought', 'commitment']).describe('Category of the journal entry'),
      topic: z.string().describe('Short topic or subject line'),
      content: z.string().describe('The journal entry content'),
      signal: z.enum(['correction', 'pattern', 'mood', 'insight', 'confirmed', 'commitment']).optional().describe('Optional signal tag for the entry'),
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
    'Read journal entries. Defaults to open entries, sorted by newest first.',
    {
      status: z.string().optional().describe('Filter by status (default: open)'),
      type: z.string().optional().describe('Filter by entry type'),
      topic: z.string().optional().describe('Text search on topic field'),
      limit: z.number().optional().describe('Max entries to return (default: 20)'),
      since: z.string().optional().describe('Only return entries created after this ISO date'),
    },
    async (params) => {
      const userId = getUserId();
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

      const result = await esClient.search({
        index: INDEX,
        size: params.limit ?? 20,
        sort: [{ created_at: { order: 'desc' } }],
        query: { bool: { must } },
      });

      const entries = result.hits.hits.map((hit) => ({
        id: hit._id,
        ...(hit._source as Record<string, unknown>),
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ entries, total: entries.length }),
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

      // Snapshot current version to history before overwriting
      try {
        const existing = await esClient.get({ index: USER_MODEL_INDEX, id: docId });
        if (existing._source) {
          await esClient.index({
            index: USER_MODEL_HISTORY_INDEX,
            document: {
              ...(existing._source as Record<string, unknown>),
              archived_at: now,
              original_id: docId,
            },
          });
        }
      } catch {
        // No existing version — first write, no snapshot needed
      }

      await esClient.index({
        index: USER_MODEL_INDEX,
        id: docId,
        document: {
          user_id: userId,
          section: params.section,
          content: params.content,
          last_updated: now,
          created_at: now,
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
            text: JSON.stringify({ section: params.section, updated: true }),
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
