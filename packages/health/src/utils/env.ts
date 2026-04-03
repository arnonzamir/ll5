export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  authSecret?: string;
  apiKey?: string;
  userId?: string;
  elasticsearchUrl: string;
  elasticsearchApiKey?: string;
  databaseUrl: string;
  encryptionKey: string;
}

export function loadEnv(): EnvConfig {
  const authSecret = process.env.AUTH_SECRET;
  const apiKey = process.env.API_KEY;

  if (!authSecret && !apiKey) {
    throw new Error('Either AUTH_SECRET or API_KEY environment variable is required');
  }

  const elasticsearchUrl = process.env.ELASTICSEARCH_URL;
  if (!elasticsearchUrl) {
    throw new Error('ELASTICSEARCH_URL environment variable is required');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required (64-char hex for AES-256)');
  }

  return {
    port: parseInt(process.env.PORT || '3006', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    authSecret,
    apiKey,
    userId: process.env.USER_ID,
    elasticsearchUrl,
    elasticsearchApiKey: process.env.ELASTICSEARCH_API_KEY,
    databaseUrl,
    encryptionKey,
  };
}
