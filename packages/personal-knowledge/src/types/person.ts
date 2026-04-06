export interface Person {
  id: string;
  userId: string;
  name: string;
  aliases: string[];
  relationship: string;
  contactInfo?: Record<string, string>;
  tags: string[];
  notes?: string;
  status: 'full' | 'contact-only';
  createdAt: string;
  updatedAt: string;
}

export interface PersonFilters {
  relationship?: string;
  tags?: string[];
  query?: string;
  status?: 'full' | 'contact-only';
}

export interface UpsertPersonInput {
  id?: string;
  name: string;
  aliases?: string[];
  relationship?: string;
  contactInfo?: Record<string, string>;
  tags?: string[];
  notes?: string;
  status?: 'full' | 'contact-only';
}
