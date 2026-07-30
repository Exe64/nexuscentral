/**
 * Structured logging. JSON in production, pretty in development.
 *
 * Secrets are never logged: the redaction list below is the backstop, not the
 * primary defence -- callers must not pass credentials in the first place.
 */

import pino from 'pino';
import { env } from './config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'feedhub-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'clientSecret',
      '*.clientSecret',
      'reddit_client_secret',
      '*.reddit_client_secret',
    ],
    censor: '[redacted]',
  },
  ...(env.LOG_PRETTY
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
