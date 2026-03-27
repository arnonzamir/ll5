export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  apiKey: string;
  userId: string;
  databaseUrl: string;
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

  return {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    apiKey,
    userId,
    databaseUrl,
  };
}
