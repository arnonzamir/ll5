export interface AuthConfig {
  /** The API key that clients must provide */
  apiKey: string;
  /** The user ID to associate with the API key (v1: single user) */
  userId: string;
}
