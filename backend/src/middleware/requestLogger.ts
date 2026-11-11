/**
 * Lightweight request logger.
 *
 * Uses pino-http for structured JSON logging in production and readable
 * pretty-printed logs in development. Every request gets an id and a
 * duration field, so slow requests are easy to grep.
 */

import pinoHttp from 'pino-http';
import pino from 'pino';
import { env, isTest } from '../config/env.js';

const logger = pino({
  // Keep test output readable — pino-http logs every request at info level.
  level: isTest ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

export const httpLogger = pinoHttp({ logger });

export { logger };
