import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';

const MEDIA_INDEX = 'll5_media';
const MEDIA_LINKS_INDEX = 'll5_media_links';

export function registerMediaTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'upload_media',
    'Register a media file (image, audio, document, etc.) by its URL. Returns the media_id for linking to entities.',
    {
      url: z.string().describe('URL where the file is stored'),
      mime_type: z.string().describe('MIME type of the file (e.g. image/jpeg, audio/mp3)'),
      filename: z.string().optional().describe('Original filename'),
      description: z.string().optional().describe('Human-readable description of the media'),
      source: z
        .enum(['chat', 'wa_export', 'camera', 'share', 'upload'])
        .optional()
        .describe('How this media was acquired'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    async (params) => {
      const userId = getUserId();
      const now = new Date().toISOString();

      const doc = {
        user_id: userId,
        url: params.url,
        mime_type: params.mime_type,
        filename: params.filename ?? null,
        description: params.description ?? null,
        source: params.source ?? null,
        tags: params.tags ?? [],
        created_at: now,
      };

      const result = await esClient.index({
        index: MEDIA_INDEX,
        document: doc,
        refresh: 'wait_for',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ media_id: result._id, url: params.url }),
          },
        ],
      };
    },
  );

  server.tool(
    'list_media',
    'Search and list media files. Supports text search on filename and description, plus filters on source, tags, and mime_type.',
    {
      query: z.string().optional().describe('Text search on filename and description'),
      source: z
        .enum(['chat', 'wa_export', 'camera', 'share', 'upload'])
        .optional()
        .describe('Filter by source'),
      tags: z.array(z.string()).optional().describe('Filter by tags (all must match)'),
      mime_type: z.string().optional().describe('Filter by MIME type (exact match)'),
      since: z.string().optional().describe('Only return media created after this ISO date'),
      limit: z.number().optional().describe('Max results to return (default: 20)'),
      offset: z.number().optional().describe('Offset for pagination (default: 0)'),
    },
    async (params) => {
      const userId = getUserId();
      const must: Record<string, unknown>[] = [{ term: { user_id: userId } }];

      if (params.query) {
        must.push({
          multi_match: {
            query: params.query,
            fields: ['filename', 'description'],
          },
        });
      }

      if (params.source) {
        must.push({ term: { source: params.source } });
      }

      if (params.tags && params.tags.length > 0) {
        for (const tag of params.tags) {
          must.push({ term: { tags: tag } });
        }
      }

      if (params.mime_type) {
        must.push({ term: { mime_type: params.mime_type } });
      }

      if (params.since) {
        must.push({ range: { created_at: { gte: params.since } } });
      }

      const result = await esClient.search({
        index: MEDIA_INDEX,
        size: params.limit ?? 20,
        from: params.offset ?? 0,
        sort: [{ created_at: { order: 'desc' } }],
        query: { bool: { must } },
      });

      const media = result.hits.hits.map((hit) => ({
        id: hit._id,
        ...(hit._source as Record<string, unknown>),
      }));

      const total =
        typeof result.hits.total === 'number'
          ? result.hits.total
          : result.hits.total?.value ?? 0;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ media, total }),
          },
        ],
      };
    },
  );

  server.tool(
    'link_media',
    'Link a media file to any entity (person, action, project, place, etc.). Uses a deterministic ID to prevent duplicate links.',
    {
      media_id: z.string().describe('ID of the media file'),
      entity_type: z.string().describe('Type of entity (e.g. person, action, project, place)'),
      entity_id: z.string().describe('ID of the entity to link to'),
    },
    async (params) => {
      const userId = getUserId();
      const now = new Date().toISOString();
      const linkId = `${params.media_id}_${params.entity_type}_${params.entity_id}`;

      await esClient.index({
        index: MEDIA_LINKS_INDEX,
        id: linkId,
        document: {
          user_id: userId,
          media_id: params.media_id,
          entity_type: params.entity_type,
          entity_id: params.entity_id,
          linked_at: now,
        },
        refresh: 'wait_for',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ linked: true }),
          },
        ],
      };
    },
  );

  server.tool(
    'unlink_media',
    'Remove the link between a media file and an entity.',
    {
      media_id: z.string().describe('ID of the media file'),
      entity_type: z.string().describe('Type of entity'),
      entity_id: z.string().describe('ID of the entity'),
    },
    async (params) => {
      const linkId = `${params.media_id}_${params.entity_type}_${params.entity_id}`;

      await esClient.delete({
        index: MEDIA_LINKS_INDEX,
        id: linkId,
        refresh: 'wait_for',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ unlinked: true }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_media_for',
    'Get all media files linked to a specific entity.',
    {
      entity_type: z.string().describe('Type of entity (e.g. person, action, project, place)'),
      entity_id: z.string().describe('ID of the entity'),
    },
    async (params) => {
      const userId = getUserId();

      // Find all links for this entity
      const linksResult = await esClient.search({
        index: MEDIA_LINKS_INDEX,
        size: 100,
        query: {
          bool: {
            must: [
              { term: { user_id: userId } },
              { term: { entity_type: params.entity_type } },
              { term: { entity_id: params.entity_id } },
            ],
          },
        },
      });

      const mediaIds = linksResult.hits.hits.map(
        (hit) => (hit._source as Record<string, unknown>).media_id as string,
      );

      if (mediaIds.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ media: [] }),
            },
          ],
        };
      }

      // Fetch the actual media records
      const mediaResult = await esClient.search({
        index: MEDIA_INDEX,
        size: mediaIds.length,
        query: {
          bool: {
            must: [{ term: { user_id: userId } }],
            filter: [{ ids: { values: mediaIds } }],
          },
        },
      });

      const media = mediaResult.hits.hits.map((hit) => ({
        id: hit._id,
        ...(hit._source as Record<string, unknown>),
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ media }),
          },
        ],
      };
    },
  );
}
