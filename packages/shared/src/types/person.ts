export interface Person {
  id: string;
  userId: string;
  name: string;
  aliases?: string[];
  relationship?: string;
  contactInfo?: Record<string, string>;
  tags?: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePersonInput {
  name: string;
  aliases?: string[];
  relationship?: string;
  contactInfo?: Record<string, string>;
  tags?: string[];
  notes?: string;
}

export interface UpdatePersonInput {
  name?: string;
  aliases?: string[];
  relationship?: string;
  contactInfo?: Record<string, string>;
  tags?: string[];
  notes?: string;
}

export interface PersonFilters {
  relationship?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}
