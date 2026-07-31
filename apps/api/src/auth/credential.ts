/**
 * The single stored credential, and how it comes into existence.
 *
 * Bootstrapping is the awkward part of a self-hosted single-user app: there is
 * nobody to send an invitation to. Two options were on the table --
 *
 *   1. a first-run setup screen, which leaves a window in which whoever loads the
 *      page first owns the instance;
 *   2. a password supplied at deploy time.
 *
 * This takes the second. `AUTH_PASSWORD` is read once, on the first boot that
 * finds no credential, and hashed straight into the database. There is no window.
 * The trade is a secret sitting in `.env`, so the API nags on every start until it
 * is removed, and the password can be changed from the UI without touching it.
 */

import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { hashPassword, passwordProblem } from './password.js';

const log = logger.child({ component: 'auth' });

export async function credentialExists(): Promise<boolean> {
  const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM auth_credential`);
  return (rows[0]?.n ?? 0) > 0;
}

export async function getPasswordHash(): Promise<string | null> {
  const { rows } = await query<{ password_hash: string }>(
    `SELECT password_hash FROM auth_credential WHERE id = true`,
  );
  return rows[0]?.password_hash ?? null;
}

export async function setPassword(password: string): Promise<void> {
  const hash = await hashPassword(password);
  await query(
    `INSERT INTO auth_credential (id, password_hash, updated_at)
     VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [hash],
  );
}

export type BootstrapOutcome =
  | { state: 'created' }
  | { state: 'exists'; envStillSet: boolean }
  | { state: 'missing' }
  | { state: 'rejected'; reason: string };

/**
 * Create the credential from `AUTH_PASSWORD` if there is not one yet.
 *
 * Returns rather than throws, so the caller decides whether an instance with no
 * credential is fatal. It is: see index.ts.
 */
export async function bootstrapCredential(): Promise<BootstrapOutcome> {
  if (await credentialExists()) {
    const envStillSet = env.AUTH_PASSWORD !== undefined;
    if (envStillSet) {
      log.warn(
        'AUTH_PASSWORD is still set but a password is already stored, so it is being ignored. ' +
          'Remove it from .env -- change the password from Settings instead.',
      );
    }
    return { state: 'exists', envStillSet };
  }

  const password = env.AUTH_PASSWORD;
  if (password === undefined) return { state: 'missing' };

  const problem = passwordProblem(password);
  if (problem !== null) return { state: 'rejected', reason: problem };

  await setPassword(password);
  log.info('Stored the initial password from AUTH_PASSWORD. Remove it from .env now.');
  return { state: 'created' };
}
