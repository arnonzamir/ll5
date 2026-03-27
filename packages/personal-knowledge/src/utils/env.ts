export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  apiKey: string;
  userId: string;
  elasticsearchUrl: string;
  elasticsearchApiKey?: string;
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

  const elasticsearchUrl = process.env.ELASTICSEARCH_URL;
  if (!elasticsearchUrl) {
    throw new Error('ELASTICSEARCH_URL environment variable is required');
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    apiKey,
    userId,
    elasticsearchUrl,
    elasticsearchApiKey: process.env.ELASTICSEARCH_API_KEY,
  };
}
