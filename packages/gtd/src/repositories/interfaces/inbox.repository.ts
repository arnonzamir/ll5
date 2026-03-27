import type {
  InboxItem,
  CaptureInboxInput,
  ProcessInboxInput,
  InboxFilters,
  PaginationParams,
  PaginatedResult,
} from '../../types/index.js';

export interface InboxRepository {
  capture(userId: string, data: CaptureInboxInput): Promise<InboxItem>;
  list(userId: string, filters: InboxFilters & PaginationParams): Promise<PaginatedResult<InboxItem>>;
  findById(userId: string, id: string): Promise<InboxItem | null>;
  process(userId: string, id: string, data: ProcessInboxInput): Promise<InboxItem>;
  delete(userId: string, id: string): Promise<boolean>;
  countByStatus(userId: string): Promise<Record<string, number>>;
}
