import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit } from '@ll5/shared';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';

export function registerActionTools(server: McpServer, repo: HorizonRepository, getUserId: () => string): void {

  // -------------------------------------------------------------------------
  // create_action
  // -------------------------------------------------------------------------
  server.tool(
    'create_action',
    'Create a new GTD action (next action / task). Supports energy level, context tags, due dates, project linking, and list types (todo, shopping, waiting, someday).',
    {
      title: z.string().describe('Action title'),
      description: z.string().optional().describe('Detailed description'),
      energy: z.enum(['low', 'medium', 'high']).optional().describe('Required energy level. Default: medium'),
      context: z.array(z.string()).optional().describe('Context tags, e.g. ["@home", "@computer"]'),
      list_type: z.enum(['todo', 'shopping', 'waiting', 'someday']).optional().describe('List type. Default: todo'),
      due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
      start_date: z.string().optional().describe('Start date -- do not show before this date (YYYY-MM-DD)'),
      project_id: z.string().optional().describe('Link to parent project (UUID)'),
      waiting_for: z.string().optional().describe('Who/what we are waiting on (when list_type=waiting)'),
      time_estimate: z.number().optional().describe('Estimated minutes to complete'),
      category: z.string().optional().describe('Free-text category'),
    },
    async (params) => {
      const userId = getUserId();
      const action = await repo.createAction(userId, {
        title: params.title,
        description: params.description,
        energy: params.energy,
        context: params.context,
        listType: params.list_type,
        dueDate: params.due_date,
        startDate: params.start_date,
        projectId: params.project_id,
        waitingFor: params.waiting_for,
        timeEstimate: params.time_estimate,
        category: params.category,
      });
      logAudit({ user_id: userId, source: 'gtd', action: 'create', entity_type: 'action', entity_id: action.id, summary: `Created action: ${params.title}` });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ action }, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // update_action
  // -------------------------------------------------------------------------
  server.tool(
    'update_action',
    'Update an existing action. Look up by ID or title search (must match exactly one). Can modify any field or mark it complete.',
    {
      id: z.string().optional().describe('Action ID (UUID). Required if title_search not provided.'),
      title_search: z.string().optional().describe('Find action by title substring. Must match exactly one.'),
      title: z.string().optional().describe('New title'),
      description: z.string().nullable().optional().describe('New description or null to clear'),
      status: z.enum(['active', 'completed', 'on_hold', 'dropped']).optional().describe('New status'),
      energy: z.enum(['low', 'medium', 'high']).nullable().optional().describe('New energy level'),
      context: z.array(z.string()).optional().describe('Replace context tags'),
      list_type: z.enum(['todo', 'shopping', 'waiting', 'someday']).optional().describe('New list type'),
      due_date: z.string().nullable().optional().describe('Due date (YYYY-MM-DD) or null to clear'),
      start_date: z.string().nullable().optional().describe('Start date (YYYY-MM-DD) or null to clear'),
      project_id: z.string().nullable().optional().describe('Link to project (UUID) or null to unlink'),
      waiting_for: z.string().nullable().optional().describe('Who/what or null to clear'),
      time_estimate: z.number().nullable().optional().describe('Minutes or null to clear'),
      category: z.string().nullable().optional().describe('Category or null to clear'),
    },
    async (params) => {
      const userId = getUserId();

      let actionId = params.id;

      if (!actionId && params.title_search) {
        const matches = await repo.findActionByTitle(userId, params.title_search);
        if (matches.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `No action found matching "${params.title_search}"` }) }],
            isError: true,
          };
        }
        if (matches.length > 1) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Multiple actions match "${params.title_search}". Please be more specific or use an ID.`,
                matches: matches.map((m) => ({ id: m.id, title: m.title })),
              }),
            }],
            isError: true,
          };
        }
        actionId = matches[0].id;
      }

      if (!actionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either id or title_search is required' }) }],
          isError: true,
        };
      }

      const updateData: Record<string, unknown> = {};
      if (params.title !== undefined) updateData.title = params.title;
      if (params.description !== undefined) updateData.description = params.description;
      if (params.status !== undefined) updateData.status = params.status;
      if (params.energy !== undefined) updateData.energy = params.energy;
      if (params.context !== undefined) updateData.context = params.context;
      if (params.list_type !== undefined) updateData.listType = params.list_type;
      if (params.due_date !== undefined) updateData.dueDate = params.due_date;
      if (params.start_date !== undefined) updateData.startDate = params.start_date;
      if (params.project_id !== undefined) updateData.projectId = params.project_id;
      if (params.waiting_for !== undefined) updateData.waitingFor = params.waiting_for;
      if (params.time_estimate !== undefined) updateData.timeEstimate = params.time_estimate;
      if (params.category !== undefined) updateData.category = params.category;

      try {
        const action = await repo.updateAction(userId, actionId, updateData);
        const actionStr = params.status === 'completed' ? 'complete' : 'update';
        logAudit({ user_id: userId, source: 'gtd', action: actionStr, entity_type: 'action', entity_id: actionId, summary: `${actionStr === 'complete' ? 'Completed' : 'Updated'} action: ${action.title}`, metadata: updateData });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ action }, null, 2) }],
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
  // list_actions
  // -------------------------------------------------------------------------
  server.tool(
    'list_actions',
    'List GTD actions with flexible filtering by status, list type, energy, context, category, project, due date, and overdue flag. Returns actions with linked project title.',
    {
      status: z.enum(['active', 'completed', 'on_hold', 'dropped']).optional().describe('Filter by status. Default: active'),
      list_type: z.enum(['todo', 'shopping', 'waiting', 'someday']).optional().describe('Filter by list type'),
      energy: z.enum(['low', 'medium', 'high']).optional().describe('Filter by energy level'),
      context: z.array(z.string()).optional().describe('Filter by context tags (match any)'),
      category: z.string().optional().describe('Filter by category'),
      project_id: z.string().optional().describe('Filter by project ID'),
      due_before: z.string().optional().describe('Actions due on or before this date (YYYY-MM-DD)'),
      due_after: z.string().optional().describe('Actions due on or after this date (YYYY-MM-DD)'),
      overdue: z.boolean().optional().describe('If true, only return actions past due and still active'),
      query: z.string().optional().describe('Free-text search in title and description'),
      limit: z.number().optional().describe('Max results. Default: 50, max: 200'),
      offset: z.number().optional().describe('Pagination offset. Default: 0'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await repo.listActions(userId, {
        status: params.status,
        listType: params.list_type,
        energy: params.energy,
        context: params.context,
        category: params.category,
        projectId: params.project_id,
        dueBefore: params.due_before,
        dueAfter: params.due_after,
        overdue: params.overdue,
        query: params.query,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ actions: result.items, total: result.total }, null, 2),
        }],
      };
    },
  );
}
