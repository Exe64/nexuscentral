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
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { attachSession, requireAuth } from './middleware/auth.js';
import { alertsRouter } from './routes/alerts.js';
import { customApiRouter } from './routes/custom-api.js';
import { dashboardsRouter } from './routes/dashboards.js';
import { itemsRouter } from './routes/items.js';
import { rulesRouter } from './routes/rules.js';
import { settingsRouter } from './routes/settings.js';
import { sourcesRouter } from './routes/sources.js';
import { tagsRouter } from './routes/tags.js';
import { updateRouter } from './routes/update.js';
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

  // Resolve the session on every request, including the public ones: `/health`
  // answers in more detail once it knows who is asking.
  app.use(attachSession);

  // --- public -------------------------------------------------------------
  // Only these two. `/health` because the container healthcheck and deploy.sh
  // need it before anyone can log in, and `/auth` because logging in cannot
  // require being logged in.
  app.use('/api', healthRouter);
  app.use('/api', authRouter);

  // --- authenticated ------------------------------------------------------
  // The gate sits here rather than on each router, so a new router added below
  // is protected by default. Getting that backwards is how endpoints leak.
  app.use('/api', requireAuth);

  app.use('/api', settingsRouter);
  app.use('/api', tagsRouter);
  app.use('/api', sourcesRouter);
  app.use('/api', rulesRouter);
  app.use('/api', dashboardsRouter);
  app.use('/api', alertsRouter);
  app.use('/api', customApiRouter);
  app.use('/api', itemsRouter);
  app.use('/api', updateRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
