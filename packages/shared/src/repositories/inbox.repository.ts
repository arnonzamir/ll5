import type { InboxItem, CreateInboxInput, ProcessInboxInput, InboxFilters, InboxStatus } from '../types/inbox.js';

export interface InboxRepository {
  find(userId: string, filters: InboxFilters): Promise<InboxItem[]>;
  findById(userId: string, id: string): Promise<InboxItem | null>;
  create(userId: string, data: CreateInboxInput): Promise<InboxItem>;
  update(userId: string, id: string, data: ProcessInboxInput): Promise<InboxItem>;
  delete(userId: string, id: string): Promise<void>;
  countByStatus(userId: string, status?: InboxStatus): Promise<number>;
}
