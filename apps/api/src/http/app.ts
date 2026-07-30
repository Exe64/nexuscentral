/**
 * The Express application, as a factory.
 *
 * Kept free of `listen` and of any worker startup so tests can mount it with
 * supertest. The worker stays independently runnable: no worker code imports
 * from the HTTP layer, and this file only reaches into it to enqueue a job.
 */

import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { healthRouter } from '../routes/health.js';
import { itemsRouter } from './routes/items.js';
import { sourcesRouter } from './routes/sources.js';
import { tagsRouter } from './routes/tags.js';
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
  // `?tagIds=1&tagIds=2` must arrive as an array, not as a nested object.
  app.set('query parser', 'simple');

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

  // Widget configs are the largest JSON bodies we accept; 1 MB is generous.
  app.use(express.json({ limit: '1mb' }));
  // An OPML file arrives as a raw upload rather than as JSON.
  app.use(
    express.text({
      type: ['text/xml', 'application/xml', 'text/x-opml', 'text/x-opml+xml'],
      limit: '5mb',
    }),
  );

  app.use('/api', healthRouter);
  app.use('/api', tagsRouter);
  app.use('/api', sourcesRouter);
  app.use('/api', itemsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
