import type { Profile, UpdateProfileInput } from '../types/profile.js';

export interface ProfileRepository {
  get(userId: string): Promise<Profile | null>;
  upsert(userId: string, data: UpdateProfileInput): Promise<Profile>;
}
