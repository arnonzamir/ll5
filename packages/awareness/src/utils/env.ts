export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  authSecret?: string;
  apiKey?: string;
  userId?: string;
  elasticsearchUrl: string;
  elasticsearchApiKey?: string;
  timezone: string;
  gatewayUrl: string;
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

  return {
    port: parseInt(process.env.PORT || '3002', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    authSecret,
    apiKey,
    userId: process.env.USER_ID,
    elasticsearchUrl,
    elasticsearchApiKey: process.env.ELASTICSEARCH_API_KEY,
    timezone: process.env.TZ || 'Asia/Jerusalem',
    gatewayUrl: process.env.GATEWAY_URL || 'http://gateway:3000',
  };
}
