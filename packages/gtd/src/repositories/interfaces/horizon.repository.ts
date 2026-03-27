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
  GtdHealth,
  PaginationParams,
  PaginatedResult,
} from '../../types/index.js';

export interface HorizonRepository {
  // Actions (h=0)
  createAction(userId: string, data: CreateActionInput): Promise<Horizon>;
  updateAction(userId: string, id: string, data: UpdateActionInput): Promise<Horizon>;
  findActionById(userId: string, id: string): Promise<Horizon | null>;
  findActionByTitle(userId: string, titleSearch: string): Promise<Horizon[]>;
  listActions(userId: string, filters: ActionFilters & PaginationParams): Promise<PaginatedResult<ActionWithProject>>;
  deleteAction(userId: string, id: string): Promise<boolean>;

  // Projects (h=1)
  createProject(userId: string, data: CreateProjectInput): Promise<Horizon>;
  updateProject(userId: string, id: string, data: UpdateProjectInput): Promise<Horizon>;
  findProjectById(userId: string, id: string): Promise<Horizon | null>;
  listProjects(userId: string, filters: ProjectFilters & PaginationParams): Promise<PaginatedResult<ProjectWithCounts>>;

  // Horizons 2-5
  upsertHorizon(userId: string, data: UpsertHorizonInput): Promise<{ item: Horizon; created: boolean }>;
  listHorizons(userId: string, filters: HorizonFilters & PaginationParams): Promise<PaginatedResult<HorizonItemWithCounts>>;

  // Health
  getHealth(userId: string): Promise<GtdHealth>;

  // Recommendations
  recommendActions(userId: string, criteria: RecommendCriteria): Promise<RecommendResult>;
}
