export interface EnvConfig {
  port: number;
  elasticsearchUrl: string;
  webhookTokens: Record<string, string>; // token -> user_id
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  nodeEnv: string;
  geocodingApiKey: string | undefined;
  authSecret: string;
  databaseUrl: string;
  // Google MCP integration (for calendar sync and periodic review)
  googleMcpUrl: string | undefined;
  googleMcpApiKey: string | undefined;
  // Calendar review schedule
  calendarReviewStartHour: number;
  calendarReviewEndHour: number;
  calendarReviewIntervalMinutes: number;
  calendarReviewTimezone: string;
  // Proactive scheduler config
  dailyReviewHour: number;
  ticklerAlertIntervalMinutes: number;
  gtdHealthIntervalHours: number;
  weeklyReviewDay: number;
  weeklyReviewHour: number;
  messageBatchIntervalMinutes: number;
  journalConsolidationHour: number;
  fcmServerKey?: string;
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

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    throw new Error('AUTH_SECRET environment variable is required');
  }
  if (authSecret.length < 32) {
    throw new Error('AUTH_SECRET must be at least 32 characters');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    port: parseInt(process.env.PORT ?? '3006', 10),
    elasticsearchUrl,
    webhookTokens,
    logLevel: logLevel as EnvConfig['logLevel'],
    nodeEnv: process.env.NODE_ENV ?? 'development',
    geocodingApiKey: process.env.GEOCODING_API_KEY,
    authSecret,
    databaseUrl,
    googleMcpUrl: process.env.GOOGLE_MCP_URL,
    googleMcpApiKey: process.env.GOOGLE_MCP_API_KEY,
    calendarReviewStartHour: parseInt(process.env.CALENDAR_REVIEW_START_HOUR ?? '7', 10),
    calendarReviewEndHour: parseInt(process.env.CALENDAR_REVIEW_END_HOUR ?? '22', 10),
    calendarReviewIntervalMinutes: parseInt(process.env.CALENDAR_REVIEW_INTERVAL_MINUTES ?? '120', 10),
    calendarReviewTimezone: process.env.CALENDAR_REVIEW_TIMEZONE ?? 'Asia/Jerusalem',
    dailyReviewHour: parseInt(process.env.DAILY_REVIEW_HOUR ?? '7', 10),
    ticklerAlertIntervalMinutes: parseInt(process.env.TICKLER_ALERT_INTERVAL_MINUTES ?? '60', 10),
    gtdHealthIntervalHours: parseInt(process.env.GTD_HEALTH_INTERVAL_HOURS ?? '4', 10),
    weeklyReviewDay: parseInt(process.env.WEEKLY_REVIEW_DAY ?? '5', 10),
    weeklyReviewHour: parseInt(process.env.WEEKLY_REVIEW_HOUR ?? '14', 10),
    messageBatchIntervalMinutes: parseInt(process.env.MESSAGE_BATCH_INTERVAL_MINUTES ?? '30', 10),
    journalConsolidationHour: parseInt(process.env.JOURNAL_CONSOLIDATION_HOUR ?? '2', 10),
    fcmServerKey: process.env.FCM_SERVER_KEY,
  };
}
