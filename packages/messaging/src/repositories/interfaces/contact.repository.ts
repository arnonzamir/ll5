export interface ContactRecord {
  id: string;
  user_id: string;
  platform: string;
  platform_id: string;
  display_name: string | null;
  phone_number: string | null;
  is_group: boolean;
  person_id: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ContactUpsertInput {
  platform: string;
  platform_id: string;
  display_name?: string;
  phone_number?: string;
  is_group?: boolean;
}

export interface ContactListParams {
  platform?: string;
  query?: string;
  hasPersonLink?: boolean;
  is_group?: boolean;
  limit?: number;
  offset?: number;
}

export interface ContactListResult {
  contacts: ContactRecord[];
  total: number;
}

export interface ContactRepository {
  /** Upsert a single contact. Updates display_name, phone_number, is_group, and last_seen_at on conflict. */
  upsert(userId: string, contact: ContactUpsertInput): Promise<ContactRecord>;

  /** Bulk upsert contacts. Returns the number of rows affected. */
  bulkUpsert(userId: string, contacts: ContactUpsertInput[]): Promise<number>;

  /** List contacts with optional filters (platform, name/phone search, person link). */
  list(userId: string, params?: ContactListParams): Promise<ContactListResult>;

  /** Resolve a contact by platform and platform_id. */
  resolve(userId: string, platform: string, platformId: string): Promise<ContactRecord | null>;

  /** Link a contact to a personal-knowledge Person by setting person_id. */
  linkPerson(userId: string, contactId: string, personId: string): Promise<void>;

  /** Remove the person link from a contact. */
  unlinkPerson(userId: string, contactId: string): Promise<void>;
}
