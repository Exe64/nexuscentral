/**
 * The Express application, as a factory.
 *
 * Kept free of `listen` and of any worker import so tests can mount it with
 * supertest and so the worker stays independently runnable: no worker code may
 * import from the HTTP layer, and the reverse holds here too.
 */

import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { healthRouter } from '../routes/health.js';
import { errorHandler, notFoundHandler } from './errors.js';

export function createApp(): Express {
  const app = express();

  // Behind Nginx. Unset means no proxy, so leave Express's default alone
  // rather than trusting a hop that does not exist.
  if (env.TRUST_PROXY !== undefined) {
    app.set('trust proxy', env.TRUST_PROXY);
  }

  // No `X-Powered-By`; it advertises the stack and buys nothing.
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(
    pinoHttp({
      logger,
      // Health checks would otherwise dominate the log at one line per poll.
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (_req, res, err) => {
        if (err !== undefined || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // Widget configs and OPML payloads are the largest bodies we accept; 1 MB is
  // generous for both and keeps a runaway request from becoming a memory issue.
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
