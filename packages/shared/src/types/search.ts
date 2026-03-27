export interface SearchOptions {
  fuzzy?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchResult<T> {
  items: T[];
  total: number;
}
