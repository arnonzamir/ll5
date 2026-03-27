export interface Fact {
  id: string;
  userId: string;
  type: string;
  category: string;
  content: string;
  provenance?: string;
  confidence?: number;
  source?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateFactInput {
  type: string;
  category: string;
  content: string;
  provenance?: string;
  confidence?: number;
  source?: string;
  tags?: string[];
}

export interface UpdateFactInput {
  type?: string;
  category?: string;
  content?: string;
  provenance?: string;
  confidence?: number;
  source?: string;
  tags?: string[];
}

export interface FactFilters {
  type?: string;
  category?: string;
  tags?: string[];
  source?: string;
  limit?: number;
  offset?: number;
}
