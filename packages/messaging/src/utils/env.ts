export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  apiKey: string;
  userId: string;
  databaseUrl: string;
  encryptionKey: string;
  evolutionApiUrl: string | null;
  /** Evolution-wide AUTHENTICATION_API_KEY used to provision new instances. */
  evolutionGlobalApiKey: string | null;
  /** Public gateway URL Evolution uses to POST webhooks. */
  gatewayUrl: string | null;
  /** Shared X-Webhook-Secret value (must match gateway WHATSAPP_WEBHOOK_SECRET). */
  whatsappWebhookSecret: string | null;
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

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required (32-byte hex string)');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }

  return {
    port: parseInt(process.env.PORT || '3004', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    apiKey,
    userId,
    databaseUrl,
    encryptionKey,
    evolutionApiUrl: process.env.EVOLUTION_API_URL || null,
    evolutionGlobalApiKey: process.env.EVOLUTION_GLOBAL_API_KEY || null,
    gatewayUrl: process.env.GATEWAY_URL || null,
    whatsappWebhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET || null,
  };
}
