import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit } from '@ll5/shared';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';

export function registerProjectTools(server: McpServer, repo: HorizonRepository, getUserId: () => string): void {

  // -------------------------------------------------------------------------
  // create_project
  // -------------------------------------------------------------------------
  server.tool(
    'create_project',
    'Create a new GTD project (multi-step outcome). Can be linked to an area of focus.',
    {
      title: z.string().describe('Project title (desired outcome)'),
      description: z.string().optional().describe('Project description and notes'),
      category: z.string().optional().describe('Free-text category'),
      area_id: z.string().optional().describe('Link to parent area (h=2 horizon ID)'),
      due_date: z.string().optional().describe('Target completion date (YYYY-MM-DD)'),
      status: z.enum(['active', 'completed', 'on_hold', 'dropped']).optional().describe('Project status. Default: active'),
    },
    async (params) => {
      const userId = getUserId();
      const project = await repo.createProject(userId, {
        title: params.title,
        description: params.description,
        category: params.category,
        areaId: params.area_id,
        dueDate: params.due_date,
        status: params.status,
      });
      logAudit({ user_id: userId, source: 'gtd', action: 'create', entity_type: 'project', entity_id: project.id, summary: `Created project: ${params.title}` });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ project }, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // update_project
  // -------------------------------------------------------------------------
  server.tool(
    'update_project',
    'Update or complete a GTD project.',
    {
      id: z.string().describe('Project ID (UUID)'),
      title: z.string().optional().describe('New title'),
      description: z.string().nullable().optional().describe('New description or null to clear'),
      category: z.string().nullable().optional().describe('New category or null to clear'),
      area_id: z.string().nullable().optional().describe('Link to area (UUID) or null to unlink'),
      due_date: z.string().nullable().optional().describe('Due date (YYYY-MM-DD) or null to clear'),
      status: z.enum(['active', 'completed', 'on_hold', 'dropped']).optional().describe('New status'),
    },
    async (params) => {
      const userId = getUserId();
      try {
        const updateData: Record<string, unknown> = {};
        if (params.title !== undefined) updateData.title = params.title;
        if (params.description !== undefined) updateData.description = params.description;
        if (params.category !== undefined) updateData.category = params.category;
        if (params.area_id !== undefined) updateData.areaId = params.area_id;
        if (params.due_date !== undefined) updateData.dueDate = params.due_date;
        if (params.status !== undefined) updateData.status = params.status;

        const project = await repo.updateProject(userId, params.id, updateData);
        logAudit({ user_id: userId, source: 'gtd', action: 'update', entity_type: 'project', entity_id: params.id, summary: `Updated project: ${project.title}`, metadata: updateData });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ project }, null, 2) }],
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
  // list_projects
  // -------------------------------------------------------------------------
  server.tool(
    'list_projects',
    'List GTD projects with active action counts. Flags projects with zero active actions.',
    {
      status: z.enum(['active', 'completed', 'on_hold', 'dropped']).optional().describe('Filter by status. Default: active'),
      category: z.string().optional().describe('Filter by category'),
      area_id: z.string().optional().describe('Filter by parent area ID'),
      query: z.string().optional().describe('Free-text search in title and description'),
      limit: z.number().optional().describe('Max results. Default: 50, max: 200'),
      offset: z.number().optional().describe('Pagination offset. Default: 0'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await repo.listProjects(userId, {
        status: params.status,
        category: params.category,
        areaId: params.area_id,
        query: params.query,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ projects: result.items, total: result.total }, null, 2),
        }],
      };
    },
  );
}
