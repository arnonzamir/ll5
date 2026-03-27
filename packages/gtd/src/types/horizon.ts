export enum HorizonLevel {
  ACTIONS = 0,
  PROJECTS = 1,
  AREAS = 2,
  GOALS = 3,
  VISION = 4,
  PURPOSE = 5,
}

export type HorizonStatus = 'active' | 'completed' | 'on_hold' | 'dropped';
export type EnergyLevel = 'low' | 'medium' | 'high';
export type ListType = 'todo' | 'shopping' | 'waiting' | 'someday';

export interface Horizon {
  id: string;
  userId: string;
  horizon: HorizonLevel;
  title: string;
  description: string | null;
  status: HorizonStatus;
  energy: EnergyLevel | null;
  listType: ListType | null;
  context: string[];
  dueDate: string | null;
  startDate: string | null;
  projectId: string | null;
  areaId: string | null;
  waitingFor: string | null;
  timeEstimate: number | null;
  category: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActionWithProject extends Horizon {
  projectTitle: string | null;
}

export interface ProjectWithCounts extends Horizon {
  activeActionCount: number;
  hasNoActions: boolean;
}

export interface HorizonItemWithCounts extends Horizon {
  activeProjectCount?: number;
}

export interface CreateActionInput {
  title: string;
  description?: string;
  energy?: EnergyLevel;
  context?: string[];
  listType?: ListType;
  dueDate?: string;
  startDate?: string;
  projectId?: string;
  waitingFor?: string;
  timeEstimate?: number;
  category?: string;
}

export interface UpdateActionInput {
  title?: string;
  description?: string | null;
  status?: HorizonStatus;
  energy?: EnergyLevel | null;
  context?: string[];
  listType?: ListType;
  dueDate?: string | null;
  startDate?: string | null;
  projectId?: string | null;
  waitingFor?: string | null;
  timeEstimate?: number | null;
  category?: string | null;
}

export interface CreateProjectInput {
  title: string;
  description?: string;
  category?: string;
  areaId?: string;
  dueDate?: string;
  status?: HorizonStatus;
}

export interface UpdateProjectInput {
  title?: string;
  description?: string | null;
  category?: string | null;
  areaId?: string | null;
  dueDate?: string | null;
  status?: HorizonStatus;
}

export interface UpsertHorizonInput {
  id?: string;
  horizon: 2 | 3 | 4 | 5;
  title: string;
  description?: string;
  status?: HorizonStatus;
}

export interface ActionFilters {
  status?: HorizonStatus;
  listType?: ListType;
  energy?: EnergyLevel;
  context?: string[];
  category?: string;
  projectId?: string;
  dueBefore?: string;
  dueAfter?: string;
  overdue?: boolean;
  query?: string;
}

export interface ProjectFilters {
  status?: HorizonStatus;
  category?: string;
  areaId?: string;
  query?: string;
}

export interface HorizonFilters {
  horizon: 2 | 3 | 4 | 5;
  status?: HorizonStatus;
  query?: string;
}

export interface RecommendCriteria {
  energy?: EnergyLevel;
  timeAvailable?: number;
  contextTags?: string[];
  limit?: number;
}

export interface RecommendResult {
  quick: ScoredAction[];
  medium: ScoredAction[];
  deep: ScoredAction[];
}

export interface ScoredAction extends ActionWithProject {
  score: number;
}

export interface GtdHealth {
  inboxCount: number;
  activeProjectCount: number;
  projectsWithoutActions: number;
  overdueCount: number;
  staleWaitingCount: number;
  activeActionCount: number;
  somedayCount: number;
  completedThisWeek: number;
  daysSinceLastReview: number | null;
}
