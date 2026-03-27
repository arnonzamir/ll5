import type { EntityStatus, EntityStatusQuery } from '../types/entity-status.js';

export interface EntityStatusRepository {
  getLatest(userId: string, entityName: string): Promise<EntityStatus | null>;
  getByName(userId: string, entityName: string, query?: EntityStatusQuery): Promise<EntityStatus[]>;
  list(userId: string, query?: EntityStatusQuery): Promise<EntityStatus[]>;
  upsert(userId: string, data: {
    entityName: string;
    summary: string;
    location?: string;
    activity?: string;
    source?: string;
    timestamp: string;
  }): Promise<EntityStatus>;
}
