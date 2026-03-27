export enum HorizonLevel {
  ACTIONS = 0,
  PROJECTS = 1,
  AREAS = 2,
  GOALS = 3,
  VISION = 4,
  PURPOSE = 5,
}

export interface Horizon {
  id: string;
  userId: string;
  horizon: HorizonLevel;
  title: string;
  description?: string;
  status: string;

  // Action-specific (horizon 0)
  energy?: 'low' | 'medium' | 'high';
  listType?: 'todo' | 'shopping' | 'waiting' | 'someday';
  context?: string[];
  dueDate?: string;
  startDate?: string;
  projectId?: string;
  areaId?: string;
  waitingFor?: string;
  timeEstimate?: string;
  category?: string;
  completedAt?: string;

  createdAt: string;
  updatedAt: string;
}

export interface CreateHorizonInput {
  horizon: HorizonLevel;
  title: string;
  description?: string;
  status?: string;
  energy?: 'low' | 'medium' | 'high';
  listType?: 'todo' | 'shopping' | 'waiting' | 'someday';
  context?: string[];
  dueDate?: string;
  startDate?: string;
  projectId?: string;
  areaId?: string;
  waitingFor?: string;
  timeEstimate?: string;
  category?: string;
}

export interface UpdateHorizonInput {
  title?: string;
  description?: string;
  status?: string;
  energy?: 'low' | 'medium' | 'high';
  listType?: 'todo' | 'shopping' | 'waiting' | 'someday';
  context?: string[];
  dueDate?: string;
  startDate?: string;
  projectId?: string;
  areaId?: string;
  waitingFor?: string;
  timeEstimate?: string;
  category?: string;
  completedAt?: string;
}

export interface HorizonFilters {
  horizon?: HorizonLevel;
  status?: string;
  listType?: string;
  energy?: string;
  context?: string[];
  projectId?: string;
  areaId?: string;
  hasDueDate?: boolean;
  dueBefore?: string;
  dueAfter?: string;
  limit?: number;
  offset?: number;
}
