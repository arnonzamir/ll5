import type { Client } from '@elastic/elasticsearch';
import type { ProfileRepository } from '../interfaces/profile.repository.js';
import type { Profile, UpdateProfileInput } from '../../types/profile.js';
import { BaseElasticsearchRepository } from './base.repository.js';

interface ProfileDoc {
  user_id: string;
  name: string;
  timezone: string;
  location?: string;
  bio?: string;
  birth_date?: string;
  languages?: string[];
  created_at: string;
  updated_at: string;
}

function docToProfile(doc: ProfileDoc, userId: string): Profile {
  return {
    userId,
    name: doc.name ?? '',
    timezone: doc.timezone ?? 'UTC',
    location: doc.location,
    bio: doc.bio,
    birthDate: doc.birth_date,
    languages: doc.languages,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class ElasticsearchProfileRepository
  extends BaseElasticsearchRepository
  implements ProfileRepository
{
  constructor(client: Client) {
    super(client, 'll5_knowledge_profile');
  }

  async get(userId: string): Promise<Profile | null> {
    try {
      const response = await this.client.get<ProfileDoc>({
        index: this.index,
        id: userId,
      });

      if (!response._source) return null;
      return docToProfile(response._source, userId);
    } catch (err: unknown) {
      const error = err as { meta?: { statusCode?: number } };
      if (error.meta?.statusCode === 404) return null;
      throw err;
    }
  }

  async upsert(userId: string, data: UpdateProfileInput): Promise<Profile> {
    const now = this.nowISO();
    const existing = await this.get(userId);

    const doc: ProfileDoc = {
      user_id: userId,
      name: data.name ?? existing?.name ?? '',
      timezone: data.timezone ?? existing?.timezone ?? 'UTC',
      location: data.location ?? existing?.location,
      bio: data.bio ?? existing?.bio,
      birth_date: data.birthDate ?? existing?.birthDate,
      languages: data.languages ?? existing?.languages,
      created_at: existing?.createdAt ?? now,
      updated_at: now,
    };

    await this.indexDoc(userId, doc as unknown as Record<string, unknown>);
    return docToProfile(doc, userId);
  }
}
