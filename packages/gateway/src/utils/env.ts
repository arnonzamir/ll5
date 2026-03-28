export interface EnvConfig {
  port: number;
  elasticsearchUrl: string;
  webhookTokens: Record<string, string>; // token -> user_id
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  nodeEnv: string;
  geocodingApiKey: string | undefined;
}

export function loadEnv(): EnvConfig {
  const elasticsearchUrl = process.env.ELASTICSEARCH_URL;
  if (!elasticsearchUrl) {
    throw new Error('ELASTICSEARCH_URL environment variable is required');
  }

  const webhookTokensRaw = process.env.WEBHOOK_TOKENS;
  if (!webhookTokensRaw) {
    throw new Error('WEBHOOK_TOKENS environment variable is required (JSON: {"token": "user_id"})');
  }

  let webhookTokens: Record<string, string>;
  try {
    webhookTokens = JSON.parse(webhookTokensRaw) as Record<string, string>;
  } catch {
    throw new Error('WEBHOOK_TOKENS must be valid JSON: {"token": "user_id"}');
  }

  if (typeof webhookTokens !== 'object' || webhookTokens === null || Array.isArray(webhookTokens)) {
    throw new Error('WEBHOOK_TOKENS must be a JSON object: {"token": "user_id"}');
  }

  const logLevel = process.env.LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be one of: debug, info, warn, error');
  }

  return {
    port: parseInt(process.env.PORT ?? '3006', 10),
    elasticsearchUrl,
    webhookTokens,
    logLevel: logLevel as EnvConfig['logLevel'],
    nodeEnv: process.env.NODE_ENV ?? 'development',
    geocodingApiKey: process.env.GEOCODING_API_KEY,
  };
}
