export interface Profile {
  userId: string;
  name: string;
  timezone: string;
  location?: string;
  bio?: string;
  birthDate?: string;
  languages?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileInput {
  name?: string;
  timezone?: string;
  location?: string;
  bio?: string;
  birthDate?: string;
  languages?: string[];
}
