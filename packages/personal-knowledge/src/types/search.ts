export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

export interface SearchResult<T> {
  entityType: 'fact' | 'person' | 'place';
  entityId: string;
  score: number;
  highlight: string;
  summary: string;
  data: T;
}

export interface SearchKnowledgeParams {
  query: string;
  entityTypes?: ('fact' | 'person' | 'place')[];
  limit?: number;
  minScore?: number;
  tags?: string[];
}
