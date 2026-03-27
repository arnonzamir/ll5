export interface Profile {
  userId: string;
  name?: string;
  timezone?: string;
  locale?: string;
  preferences?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileInput {
  name?: string;
  timezone?: string;
  locale?: string;
  preferences?: Record<string, unknown>;
}
