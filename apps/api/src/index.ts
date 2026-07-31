/**
 * Process entrypoint: start the HTTP server, warn about unsafe exposure, and
 * shut down cleanly.
 */

import type { Server } from 'node:http';
import { closePool } from './db/pool.js';
import { env, isProduction } from './config/env.js';
import { bootstrapCredential } from './auth/credential.js';
import { pruneExpiredSessions } from './auth/sessions.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';
import { VERSION } from './version.js';
import { seedIfEmpty } from './seed.js';
import { startWorker, stopWorker } from './worker/index.js';

/**
 * Binding to every interface without a configured proxy hop count means client
 * IPs are wrong -- and the login rate limiter counts per IP, so getting this
 * wrong turns a per-address limit into a single global bucket.
 */
function warnIfPubliclyBound(): void {
  const wildcard = env.BIND_ADDR === '0.0.0.0' || env.BIND_ADDR === '::';
  if (wildcard && env.TRUST_PROXY === undefined) {
    logger.warn(
      { bindAddr: env.BIND_ADDR },
      'API is bound to all interfaces with TRUST_PROXY unset. ' +
        'Client IPs will be the proxy address, which collapses the per-IP login ' +
        'rate limit into one bucket. Set TRUST_PROXY to the number of hops.',
    );
  }
}

/**
 * Refuse to serve without a password.
 *
 * The alternative -- start anyway and show a setup screen -- leaves a window in
 * which whoever loads the page first owns the instance. Exiting is louder and has
 * no such window.
 */
async function ensureCredential(): Promise<void> {
  const outcome = await bootstrapCredential();

  if (outcome.state === 'missing') {
    logger.fatal(
      'No password is configured and AUTH_PASSWORD is not set. ' +
        'Set AUTH_PASSWORD in .env to the password you want, start once, then remove it.',
    );
    process.exit(1);
  }

  if (outcome.state === 'rejected') {
    logger.fatal({ reason: outcome.reason }, 'AUTH_PASSWORD was rejected');
    process.exit(1);
  }
}

function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Stop accepting connections, then drain the pool. Force-exit if a client
    // holds a keep-alive socket open past the grace period.
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, exiting');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close((err) => {
      void (async (): Promise<void> => {
        if (err) logger.error({ err }, 'Error closing HTTP server');
        try {
          // Let in-flight polls finish before the pool they use goes away.
          await stopWorker();
        } catch (workerErr) {
          logger.error({ err: workerErr }, 'Error stopping worker');
        }
        try {
          await closePool();
        } catch (poolErr) {
          logger.error({ err: poolErr }, 'Error closing database pool');
        }
        clearTimeout(forceExit);
        process.exit(err ? 1 : 0);
      })();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
}

async function main(): Promise<void> {
  warnIfPubliclyBound();

  // Before `listen`: an instance with no credential must never accept a request.
  await ensureCredential();

  const app = createApp();
  const server = app.listen(env.PORT, env.BIND_ADDR, () => {
    logger.info(
      {
        version: VERSION,
        bindAddr: env.BIND_ADDR,
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
        workerEnabled: env.WORKER_ENABLED,
      },
      'nexuscentral API listening',
    );

    // First boot creates the Home dashboard. Failing here must not stop the
    // API serving: an empty dashboard list is a recoverable state.
    void seedIfEmpty().catch((err: unknown) => {
      logger.error({ err }, 'Could not seed the initial dashboard');
    });

    // Sessions expire on read, but a session nobody ever comes back for would sit
    // in the table forever. One sweep at boot is enough at this scale.
    void pruneExpiredSessions()
      .then((n) => {
        if (n > 0) logger.info({ pruned: n }, 'Swept expired sessions');
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'Could not sweep expired sessions');
      });

    if (env.WORKER_ENABLED) {
      // Started after the server is listening: a worker that cannot reach
      // PostgreSQL must not stop /api/health from reporting why.
      void startWorker().catch((err: unknown) => {
        logger.error({ err }, 'Worker failed to start; polling is not running');
      });
    } else {
      logger.info('Worker is disabled in this process (WORKER_ENABLED=false)');
    }
  });

  // Nginx's default keep-alive is 75s; outliving it avoids races where the
  // proxy reuses a socket we are closing.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  installShutdownHandlers(server);

  if (!isProduction) {
    logger.debug({ databaseUrlHost: safeDbHost(env.DATABASE_URL) }, 'Database target');
  }
}

/** Host and database name only -- the connection string carries a password. */
function safeDbHost(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
