export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  apiKey: string;
  userId: string;
  databaseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  encryptionKey: string;
}

export function loadEnv(): EnvConfig {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY environment variable is required');
  }

  const userId = process.env.USER_ID;
  if (!userId) {
    throw new Error('USER_ID environment variable is required');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    throw new Error('GOOGLE_CLIENT_ID environment variable is required');
  }

  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!googleClientSecret) {
    throw new Error('GOOGLE_CLIENT_SECRET environment variable is required');
  }

  const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!googleRedirectUri) {
    throw new Error('GOOGLE_REDIRECT_URI environment variable is required');
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  if (encryptionKey.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 32-byte hex string (64 hex characters)');
  }

  return {
    port: parseInt(process.env.PORT || '3003', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    apiKey,
    userId,
    databaseUrl,
    googleClientId,
    googleClientSecret,
    googleRedirectUri,
    encryptionKey,
  };
}
