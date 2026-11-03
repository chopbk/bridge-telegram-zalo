import pino from 'pino';
import { getEnv } from './env.js';

function createLogger() {
  let level = 'info';
  try {
    level = getEnv().LOG_LEVEL;
  } catch {
    level = process.env.LOG_LEVEL ?? 'info';
  }

  return pino({
    level,
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
  });
}

const logger = createLogger();
export default logger;
