export const FACT_TYPES = [
  'preference',
  'habit',
  'biographical',
  'medical',
  'dietary',
  'technical',
  'opinion',
  'other',
] as const;

export type FactType = (typeof FACT_TYPES)[number];

export const PROVENANCE_VALUES = [
  'user-stated',
  'inferred',
  'observed',
] as const;

export type Provenance = (typeof PROVENANCE_VALUES)[number];

export interface Fact {
  id: string;
  userId: string;
  type: FactType;
  category: string;
  content: string;
  provenance: Provenance;
  confidence: number;
  tags: string[];
  source?: string;
  validFrom?: string;
  validUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FactFilters {
  type?: FactType;
  category?: string;
  tags?: string[];
  provenance?: Provenance;
  minConfidence?: number;
  query?: string;
}

export interface UpsertFactInput {
  id?: string;
  type: FactType;
  category: string;
  content: string;
  provenance: Provenance;
  confidence: number;
  tags?: string[];
  source?: string;
  validFrom?: string;
  validUntil?: string;
}
