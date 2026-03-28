import type { EntityStatus } from '../../types/entity-status.js';

export interface EntityStatusRepository {
  /** Get status for a specific entity (fuzzy name match). */
  getByName(userId: string, entityName: string): Promise<EntityStatus | null>;

  /** List recently updated entity statuses. */
  listRecent(userId: string, params: {
    since?: string;
    limit?: number;
  }): Promise<EntityStatus[]>;

  /** Upsert an entity status. */
  upsert(userId: string, data: {
    entityName: string;
    summary: string;
    location?: string;
    activity?: string;
    source?: string;
    timestamp: string;
  }): Promise<EntityStatus>;
}
