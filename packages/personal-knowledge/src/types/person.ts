export interface Person {
  id: string;
  userId: string;
  name: string;
  aliases: string[];
  relationship: string;
  contactInfo?: Record<string, string>;
  tags: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonFilters {
  relationship?: string;
  tags?: string[];
  query?: string;
}

export interface UpsertPersonInput {
  id?: string;
  name: string;
  aliases?: string[];
  relationship?: string;
  contactInfo?: Record<string, string>;
  tags?: string[];
  notes?: string;
}
