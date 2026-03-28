export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  authSecret?: string;
  apiKey?: string;
  userId?: string;
  databaseUrl: string;
}

export function loadEnv(): EnvConfig {
  const authSecret = process.env.AUTH_SECRET;
  const apiKey = process.env.API_KEY;

  if (!authSecret && !apiKey) {
    throw new Error('Either AUTH_SECRET or API_KEY environment variable is required');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    authSecret,
    apiKey,
    userId: process.env.USER_ID,
    databaseUrl,
  };
}
