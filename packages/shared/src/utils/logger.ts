export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

const LOG_LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): number {
  const level = process.env['LOG_LEVEL']?.toLowerCase() ?? 'info';
  return LOG_LEVELS[level] ?? LOG_LEVELS['info']!;
}

export function createLogger(service: string): Logger {
  const configuredLevel = getConfiguredLevel();

  function log(level: string, msg: string, data?: Record<string, unknown>): void {
    const levelNum = LOG_LEVELS[level];
    if (levelNum === undefined || levelNum < configuredLevel) return;

    const entry = {
      level,
      service,
      msg,
      timestamp: new Date().toISOString(),
      ...data,
    };

    const output = JSON.stringify(entry);

    if (level === 'error') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  return {
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
    debug: (msg, data) => log('debug', msg, data),
  };
}
