import type { Pool } from 'pg';
import { BasePostgresRepository, mapHorizonRow } from './base.repository.js';
import type { HorizonRepository } from '../interfaces/horizon.repository.js';
import type {
  Horizon,
  ActionWithProject,
  ProjectWithCounts,
  HorizonItemWithCounts,
  CreateActionInput,
  UpdateActionInput,
  CreateProjectInput,
  UpdateProjectInput,
  UpsertHorizonInput,
  ActionFilters,
  ProjectFilters,
  HorizonFilters,
  RecommendCriteria,
  RecommendResult,
  ScoredAction,
  GtdHealth,
  PaginationParams,
  PaginatedResult,
  HorizonStatus,
} from '../../types/index.js';

export class PostgresHorizonRepository extends BasePostgresRepository implements HorizonRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  // ---------------------------------------------------------------------------
  // Actions (h=0)
  // ---------------------------------------------------------------------------

  async createAction(userId: string, data: CreateActionInput): Promise<Horizon> {
    const sql = `
      INSERT INTO gtd_horizons (
        user_id, horizon, title, description, status, energy, list_type,
        context, due_date, start_date, project_id, waiting_for,
        time_estimate, category
      ) VALUES (
        $1, 0, $2, $3, 'active', $4, $5,
        $6::jsonb, $7, $8, $9, $10,
        $11, $12
      )
      RETURNING *
    `;
    const params = [
      userId,
      data.title,
      data.description ?? null,
      data.energy ?? 'medium',
      data.listType ?? 'todo',
      JSON.stringify(data.context ?? []),
      data.dueDate ?? null,
      data.startDate ?? null,
      data.projectId ?? null,
      data.waitingFor ?? null,
      data.timeEstimate ?? null,
      data.category ?? null,
    ];
    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    return mapHorizonRow(row!) as unknown as Horizon;
  }

  async updateAction(userId: string, id: string, data: UpdateActionInput): Promise<Horizon> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Always update updated_at
    setClauses.push(`updated_at = now()`);

    const fieldMap: Record<string, { column: string; transform?: (v: unknown) => unknown }> = {
      title: { column: 'title' },
      description: { column: 'description' },
      status: { column: 'status' },
      energy: { column: 'energy' },
      context: { column: 'context', transform: (v) => JSON.stringify(v ?? []) },
      listType: { column: 'list_type' },
      dueDate: { column: 'due_date' },
      startDate: { column: 'start_date' },
      projectId: { column: 'project_id' },
      waitingFor: { column: 'waiting_for' },
      timeEstimate: { column: 'time_estimate' },
      category: { column: 'category' },
    };

    for (const [key, mapping] of Object.entries(fieldMap)) {
      if (key in data) {
        const value = (data as Record<string, unknown>)[key];
        const transformed = mapping.transform ? mapping.transform(value) : value;
        setClauses.push(`${mapping.column} = $${paramIdx}`);
        params.push(transformed);
        paramIdx++;
      }
    }

    // Auto-set completed_at when status changes to completed
    if (data.status === 'completed') {
      setClauses.push(`completed_at = now()`);
    } else if (data.status) {
      setClauses.push(`completed_at = NULL`);
    }

    params.push(id, userId);
    const sql = `
      UPDATE gtd_horizons
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1} AND horizon = 0
      RETURNING *
    `;

    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    if (!row) {
      throw new Error(`Action not found: ${id}`);
    }
    return mapHorizonRow(row) as unknown as Horizon;
  }

  async findActionById(userId: string, id: string): Promise<Horizon | null> {
    const sql = `SELECT * FROM gtd_horizons WHERE id = $1 AND user_id = $2 AND horizon = 0`;
    const row = await this.queryOne<Record<string, unknown>>(sql, [id, userId]);
    return row ? mapHorizonRow(row) as unknown as Horizon : null;
  }

  async findActionByTitle(userId: string, titleSearch: string): Promise<Horizon[]> {
    const sql = `
      SELECT * FROM gtd_horizons
      WHERE user_id = $1 AND horizon = 0 AND title ILIKE '%' || $2 || '%'
      ORDER BY created_at DESC
    `;
    const rows = await this.query<Record<string, unknown>>(sql, [userId, titleSearch]);
    return rows.map((r) => mapHorizonRow(r) as unknown as Horizon);
  }

  async listActions(
    userId: string,
    filters: ActionFilters & PaginationParams,
  ): Promise<PaginatedResult<ActionWithProject>> {
    const whereClauses: string[] = ['h.user_id = $1', 'h.horizon = 0'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (filters.status) {
      whereClauses.push(`h.status = $${paramIdx}`);
      params.push(filters.status);
      paramIdx++;
    } else {
      // Default to active
      whereClauses.push(`h.status = 'active'`);
    }

    if (filters.listType) {
      whereClauses.push(`h.list_type = $${paramIdx}`);
      params.push(filters.listType);
      paramIdx++;
    }

    if (filters.energy) {
      whereClauses.push(`h.energy = $${paramIdx}`);
      params.push(filters.energy);
      paramIdx++;
    }

    if (filters.context && filters.context.length > 0) {
      // Match actions that contain ANY of the provided context tags
      whereClauses.push(`h.context ?| $${paramIdx}`);
      params.push(filters.context);
      paramIdx++;
    }

    if (filters.category) {
      whereClauses.push(`h.category = $${paramIdx}`);
      params.push(filters.category);
      paramIdx++;
    }

    if (filters.projectId) {
      whereClauses.push(`h.project_id = $${paramIdx}`);
      params.push(filters.projectId);
      paramIdx++;
    }

    if (filters.dueBefore) {
      whereClauses.push(`h.due_date <= $${paramIdx}`);
      params.push(filters.dueBefore);
      paramIdx++;
    }

    if (filters.dueAfter) {
      whereClauses.push(`h.due_date >= $${paramIdx}`);
      params.push(filters.dueAfter);
      paramIdx++;
    }

    if (filters.overdue) {
      whereClauses.push(`h.due_date < CURRENT_DATE AND h.status = 'active'`);
    }

    if (filters.query) {
      whereClauses.push(`(h.title ILIKE '%' || $${paramIdx} || '%' OR h.description ILIKE '%' || $${paramIdx} || '%')`);
      params.push(filters.query);
      paramIdx++;
    }

    // Exclude future start_date by default
    whereClauses.push(`(h.start_date IS NULL OR h.start_date <= CURRENT_DATE)`);

    const whereStr = whereClauses.join(' AND ');

    const countSql = `SELECT COUNT(*) FROM gtd_horizons h WHERE ${whereStr}`;
    const total = await this.queryCount(countSql, params);

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const dataSql = `
      SELECT h.*, p.title AS project_title
      FROM gtd_horizons h
      LEFT JOIN gtd_horizons p ON h.project_id = p.id AND p.horizon = 1
      WHERE ${whereStr}
      ORDER BY h.due_date ASC NULLS LAST, h.created_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const rows = await this.query<Record<string, unknown>>(dataSql, params);
    const items = rows.map((r) => {
      const mapped = mapHorizonRow(r) as unknown as ActionWithProject;
      (mapped as unknown as Record<string, unknown>).projectTitle = r.project_title ?? null;
      return mapped;
    });

    return { items, total };
  }

  async deleteAction(userId: string, id: string): Promise<boolean> {
    const sql = `DELETE FROM gtd_horizons WHERE id = $1 AND user_id = $2 AND horizon = 0`;
    const rows = await this.query(sql, [id, userId]);
    // pg returns rowCount via query result, but our wrapper returns rows
    // Use a RETURNING clause instead
    const checkSql = `DELETE FROM gtd_horizons WHERE id = $1 AND user_id = $2 AND horizon = 0 RETURNING id`;
    const deleted = await this.queryOne<{ id: string }>(checkSql, [id, userId]);
    return deleted !== null;
  }

  // ---------------------------------------------------------------------------
  // Projects (h=1)
  // ---------------------------------------------------------------------------

  async createProject(userId: string, data: CreateProjectInput): Promise<Horizon> {
    const sql = `
      INSERT INTO gtd_horizons (
        user_id, horizon, title, description, status,
        category, area_id, due_date
      ) VALUES (
        $1, 1, $2, $3, $4, $5, $6, $7
      )
      RETURNING *
    `;
    const params = [
      userId,
      data.title,
      data.description ?? null,
      data.status ?? 'active',
      data.category ?? null,
      data.areaId ?? null,
      data.dueDate ?? null,
    ];
    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    return mapHorizonRow(row!) as unknown as Horizon;
  }

  async updateProject(userId: string, id: string, data: UpdateProjectInput): Promise<Horizon> {
    const setClauses: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    let paramIdx = 1;

    const fieldMap: Record<string, string> = {
      title: 'title',
      description: 'description',
      category: 'category',
      areaId: 'area_id',
      dueDate: 'due_date',
      status: 'status',
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (key in data) {
        setClauses.push(`${column} = $${paramIdx}`);
        params.push((data as Record<string, unknown>)[key]);
        paramIdx++;
      }
    }

    if (data.status === 'completed') {
      setClauses.push(`completed_at = now()`);
    } else if (data.status) {
      setClauses.push(`completed_at = NULL`);
    }

    params.push(id, userId);
    const sql = `
      UPDATE gtd_horizons
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1} AND horizon = 1
      RETURNING *
    `;

    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    if (!row) {
      throw new Error(`Project not found: ${id}`);
    }
    return mapHorizonRow(row) as unknown as Horizon;
  }

  async findProjectById(userId: string, id: string): Promise<Horizon | null> {
    const sql = `SELECT * FROM gtd_horizons WHERE id = $1 AND user_id = $2 AND horizon = 1`;
    const row = await this.queryOne<Record<string, unknown>>(sql, [id, userId]);
    return row ? mapHorizonRow(row) as unknown as Horizon : null;
  }

  async listProjects(
    userId: string,
    filters: ProjectFilters & PaginationParams,
  ): Promise<PaginatedResult<ProjectWithCounts>> {
    const whereClauses: string[] = ['h.user_id = $1', 'h.horizon = 1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (filters.status) {
      whereClauses.push(`h.status = $${paramIdx}`);
      params.push(filters.status);
      paramIdx++;
    } else {
      whereClauses.push(`h.status = 'active'`);
    }

    if (filters.category) {
      whereClauses.push(`h.category = $${paramIdx}`);
      params.push(filters.category);
      paramIdx++;
    }

    if (filters.areaId) {
      whereClauses.push(`h.area_id = $${paramIdx}`);
      params.push(filters.areaId);
      paramIdx++;
    }

    if (filters.query) {
      whereClauses.push(`(h.title ILIKE '%' || $${paramIdx} || '%' OR h.description ILIKE '%' || $${paramIdx} || '%')`);
      params.push(filters.query);
      paramIdx++;
    }

    const whereStr = whereClauses.join(' AND ');

    const countSql = `SELECT COUNT(*) FROM gtd_horizons h WHERE ${whereStr}`;
    const total = await this.queryCount(countSql, params);

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const dataSql = `
      SELECT h.*,
        COALESCE(ac.cnt, 0) AS active_action_count
      FROM gtd_horizons h
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS cnt
        FROM gtd_horizons
        WHERE horizon = 0 AND status = 'active' AND user_id = $1
        GROUP BY project_id
      ) ac ON ac.project_id = h.id
      WHERE ${whereStr}
      ORDER BY h.created_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const rows = await this.query<Record<string, unknown>>(dataSql, params);
    const items = rows.map((r) => {
      const mapped = mapHorizonRow(r) as Record<string, unknown>;
      const count = Number(r.active_action_count ?? 0);
      mapped.activeActionCount = count;
      mapped.hasNoActions = count === 0 && mapped.status === 'active';
      return mapped as unknown as ProjectWithCounts;
    });

    return { items, total };
  }

  // ---------------------------------------------------------------------------
  // Horizons 2-5
  // ---------------------------------------------------------------------------

  async upsertHorizon(
    userId: string,
    data: UpsertHorizonInput,
  ): Promise<{ item: Horizon; created: boolean }> {
    if (data.id) {
      // Update existing
      const setClauses: string[] = ['updated_at = now()'];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (data.title !== undefined) {
        setClauses.push(`title = $${paramIdx}`);
        params.push(data.title);
        paramIdx++;
      }
      if (data.description !== undefined) {
        setClauses.push(`description = $${paramIdx}`);
        params.push(data.description);
        paramIdx++;
      }
      if (data.status !== undefined) {
        setClauses.push(`status = $${paramIdx}`);
        params.push(data.status);
        paramIdx++;
        if (data.status === 'completed') {
          setClauses.push(`completed_at = now()`);
        }
      }

      params.push(data.id, userId);
      const sql = `
        UPDATE gtd_horizons
        SET ${setClauses.join(', ')}
        WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1} AND horizon >= 2
        RETURNING *
      `;
      const row = await this.queryOne<Record<string, unknown>>(sql, params);
      if (!row) {
        throw new Error(`Horizon item not found: ${data.id}`);
      }
      return { item: mapHorizonRow(row) as unknown as Horizon, created: false };
    } else {
      // Create new
      const sql = `
        INSERT INTO gtd_horizons (user_id, horizon, title, description, status)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;
      const params = [
        userId,
        data.horizon,
        data.title,
        data.description ?? null,
        data.status ?? 'active',
      ];
      const row = await this.queryOne<Record<string, unknown>>(sql, params);
      return { item: mapHorizonRow(row!) as unknown as Horizon, created: true };
    }
  }

  async listHorizons(
    userId: string,
    filters: HorizonFilters & PaginationParams,
  ): Promise<PaginatedResult<HorizonItemWithCounts>> {
    const whereClauses: string[] = ['h.user_id = $1', `h.horizon = $2`];
    const params: unknown[] = [userId, filters.horizon];
    let paramIdx = 3;

    if (filters.status) {
      whereClauses.push(`h.status = $${paramIdx}`);
      params.push(filters.status);
      paramIdx++;
    } else {
      whereClauses.push(`h.status = 'active'`);
    }

    if (filters.query) {
      whereClauses.push(`(h.title ILIKE '%' || $${paramIdx} || '%' OR h.description ILIKE '%' || $${paramIdx} || '%')`);
      params.push(filters.query);
      paramIdx++;
    }

    const whereStr = whereClauses.join(' AND ');

    const countSql = `SELECT COUNT(*) FROM gtd_horizons h WHERE ${whereStr}`;
    const total = await this.queryCount(countSql, params);

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    // For h=2 (areas), include linked project counts
    const isArea = filters.horizon === 2;
    let dataSql: string;

    if (isArea) {
      dataSql = `
        SELECT h.*,
          COALESCE(pc.cnt, 0) AS active_project_count
        FROM gtd_horizons h
        LEFT JOIN (
          SELECT area_id, COUNT(*) AS cnt
          FROM gtd_horizons
          WHERE horizon = 1 AND status = 'active' AND user_id = $1
          GROUP BY area_id
        ) pc ON pc.area_id = h.id
        WHERE ${whereStr}
        ORDER BY h.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;
    } else {
      dataSql = `
        SELECT h.*
        FROM gtd_horizons h
        WHERE ${whereStr}
        ORDER BY h.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;
    }
    params.push(limit, offset);

    const rows = await this.query<Record<string, unknown>>(dataSql, params);
    const items = rows.map((r) => {
      const mapped = mapHorizonRow(r) as Record<string, unknown>;
      if (isArea) {
        mapped.activeProjectCount = Number(r.active_project_count ?? 0);
      }
      return mapped as unknown as HorizonItemWithCounts;
    });

    return { items, total };
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async getHealth(userId: string): Promise<GtdHealth> {
    // Run multiple counts in a single query for efficiency
    const sql = `
      SELECT
        (SELECT COUNT(*) FROM gtd_inbox WHERE user_id = $1 AND status = 'captured') AS inbox_count,
        (SELECT COUNT(*) FROM gtd_horizons WHERE user_id = $1 AND horizon = 1 AND status = 'active') AS active_project_count,
        (SELECT COUNT(*) FROM gtd_horizons p
          WHERE p.user_id = $1 AND p.horizon = 1 AND p.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM gtd_horizons a
            WHERE a.project_id = p.id AND a.horizon = 0 AND a.status = 'active'
          )
        ) AS projects_without_actions,
        (SELECT COUNT(*) FROM gtd_horizons
          WHERE user_id = $1 AND horizon = 0 AND status = 'active'
          AND due_date < CURRENT_DATE
        ) AS overdue_count,
        (SELECT COUNT(*) FROM gtd_horizons
          WHERE user_id = $1 AND horizon = 0 AND status = 'active'
          AND list_type = 'waiting'
          AND updated_at < NOW() - INTERVAL '7 days'
        ) AS stale_waiting_count,
        (SELECT COUNT(*) FROM gtd_horizons
          WHERE user_id = $1 AND horizon = 0 AND status = 'active'
        ) AS active_action_count,
        (SELECT COUNT(*) FROM gtd_horizons
          WHERE user_id = $1 AND horizon = 0 AND list_type = 'someday' AND status = 'active'
        ) AS someday_count,
        (SELECT COUNT(*) FROM gtd_horizons
          WHERE user_id = $1 AND horizon = 0 AND status = 'completed'
          AND completed_at >= NOW() - INTERVAL '7 days'
        ) AS completed_this_week,
        (SELECT EXTRACT(DAY FROM NOW() - MAX(started_at))
          FROM gtd_review_sessions WHERE user_id = $1 AND status = 'completed'
        ) AS days_since_last_review
    `;

    const row = await this.queryOne<Record<string, unknown>>(sql, [userId]);
    if (!row) {
      return {
        inboxCount: 0,
        activeProjectCount: 0,
        projectsWithoutActions: 0,
        overdueCount: 0,
        staleWaitingCount: 0,
        activeActionCount: 0,
        somedayCount: 0,
        completedThisWeek: 0,
        daysSinceLastReview: null,
      };
    }

    return {
      inboxCount: Number(row.inbox_count),
      activeProjectCount: Number(row.active_project_count),
      projectsWithoutActions: Number(row.projects_without_actions),
      overdueCount: Number(row.overdue_count),
      staleWaitingCount: Number(row.stale_waiting_count),
      activeActionCount: Number(row.active_action_count),
      somedayCount: Number(row.someday_count),
      completedThisWeek: Number(row.completed_this_week),
      daysSinceLastReview: row.days_since_last_review != null
        ? Math.floor(Number(row.days_since_last_review))
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Recommendations
  // ---------------------------------------------------------------------------

  async recommendActions(userId: string, criteria: RecommendCriteria): Promise<RecommendResult> {
    const whereClauses: string[] = [
      'h.user_id = $1',
      'h.horizon = 0',
      `h.status = 'active'`,
      `h.list_type = 'todo'`,
      `(h.start_date IS NULL OR h.start_date <= CURRENT_DATE)`,
    ];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    // Filter by energy: allow equal or lower energy
    if (criteria.energy) {
      const energyLevels: Record<string, string[]> = {
        low: ['low'],
        medium: ['low', 'medium'],
        high: ['low', 'medium', 'high'],
      };
      const allowed = energyLevels[criteria.energy] ?? ['low', 'medium', 'high'];
      whereClauses.push(`(h.energy IS NULL OR h.energy = ANY($${paramIdx}))`);
      params.push(allowed);
      paramIdx++;
    }

    // Filter by context if provided
    if (criteria.contextTags && criteria.contextTags.length > 0) {
      whereClauses.push(`(h.context = '[]'::jsonb OR h.context ?| $${paramIdx})`);
      params.push(criteria.contextTags);
      paramIdx++;
    }

    const whereStr = whereClauses.join(' AND ');

    const sql = `
      SELECT h.*, p.title AS project_title
      FROM gtd_horizons h
      LEFT JOIN gtd_horizons p ON h.project_id = p.id AND p.horizon = 1
      WHERE ${whereStr}
      ORDER BY h.due_date ASC NULLS LAST, h.created_at DESC
    `;

    const rows = await this.query<Record<string, unknown>>(sql, params);

    const limit = criteria.limit ?? 5;
    const quick: ScoredAction[] = [];
    const medium: ScoredAction[] = [];
    const deep: ScoredAction[] = [];

    for (const r of rows) {
      const mapped = mapHorizonRow(r) as Record<string, unknown>;
      mapped.projectTitle = r.project_title ?? null;

      // Calculate score
      let score = 0;
      const dueDate = mapped.dueDate as string | null;
      if (dueDate) {
        const due = new Date(dueDate);
        const now = new Date();
        const diffDays = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays < 0) {
          score += 10; // overdue
        } else if (diffDays <= 3) {
          score += 5; // due within 3 days
        }
      }

      if (criteria.contextTags && criteria.contextTags.length > 0) {
        const actionContext = mapped.context as string[];
        if (actionContext.some((c: string) => criteria.contextTags!.includes(c))) {
          score += 3;
        }
      }

      if (criteria.energy && mapped.energy === criteria.energy) {
        score += 2;
      }

      mapped.score = score;
      const action = mapped as unknown as ScoredAction;

      // Bucket by time estimate
      const timeEst = mapped.timeEstimate as number | null;
      if (timeEst != null) {
        if (timeEst <= 15) {
          quick.push(action);
        } else if (timeEst <= 60) {
          medium.push(action);
        } else {
          deep.push(action);
        }
      } else {
        // No estimate: put in quick if low energy, medium otherwise
        const energy = mapped.energy as string | null;
        if (energy === 'low') {
          quick.push(action);
        } else if (energy === 'high') {
          deep.push(action);
        } else {
          medium.push(action);
        }
      }
    }

    // Sort each group by score DESC and limit
    const sortAndLimit = (arr: ScoredAction[]): ScoredAction[] =>
      arr.sort((a, b) => b.score - a.score).slice(0, limit);

    return {
      quick: sortAndLimit(quick),
      medium: sortAndLimit(medium),
      deep: sortAndLimit(deep),
    };
  }
}
