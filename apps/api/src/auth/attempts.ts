/**
 * Login rate limiting.
 *
 * Two windows, because they stop different things:
 *
 *   - **per IP**: the ordinary case, someone guessing from one place.
 *   - **global**: a distributed attempt, where every request has a fresh source
 *     address and a per-IP counter never trips. One user means a global lockout
 *     costs that user a wait and costs an attacker the whole attack.
 *
 * A successful login clears the caller's own history, so a mistyped password
 * followed by the right one does not leave the counter armed.
 */

import { query } from '../db/pool.js';

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_PER_IP = 5;
export const MAX_GLOBAL = 20;

export interface RateVerdict {
  allowed: boolean;
  /** Seconds until the next attempt is permitted. Zero when allowed. */
  retryAfter: number;
  scope: 'ip' | 'global' | null;
}

/** `null` for an unknown address, which counts only against the global window. */
function normaliseIp(ip: string | undefined): string | null {
  if (ip === undefined || ip === '') return null;
  // Express reports IPv4 over IPv6 as ::ffff:1.2.3.4; inet accepts it, but
  // storing the plain form keeps the counters from splitting across two spellings.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export async function checkRateLimit(rawIp: string | undefined): Promise<RateVerdict> {
  const ip = normaliseIp(rawIp);
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const { rows } = await query<{
    ip_failures: number;
    global_failures: number;
    oldest: Date | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE $2::inet IS NOT NULL AND ip = $2::inet)::int AS ip_failures,
       count(*)::int                                                       AS global_failures,
       min(at)                                                             AS oldest
     FROM auth_attempts
     WHERE successful = false AND at > $1::timestamptz`,
    [since, ip],
  );

  const row = rows[0];
  if (row === undefined) return { allowed: true, retryAfter: 0, scope: null };

  const retryAfter =
    row.oldest === null
      ? 0
      : Math.max(1, Math.ceil((new Date(row.oldest).getTime() + WINDOW_MS - Date.now()) / 1000));

  if (ip !== null && row.ip_failures >= MAX_PER_IP) {
    return { allowed: false, retryAfter, scope: 'ip' };
  }
  if (row.global_failures >= MAX_GLOBAL) {
    return { allowed: false, retryAfter, scope: 'global' };
  }

  return { allowed: true, retryAfter: 0, scope: null };
}

export async function recordAttempt(rawIp: string | undefined, successful: boolean): Promise<void> {
  const ip = normaliseIp(rawIp);
  await query(`INSERT INTO auth_attempts (ip, successful) VALUES ($1::inet, $2)`, [ip, successful]);

  if (successful && ip !== null) {
    // A mistyped password before the right one should not leave the counter armed.
    await query(`DELETE FROM auth_attempts WHERE ip = $1::inet AND successful = false`, [ip]);
  }
}

/** Housekeeping: the table is an audit trail, not an archive. */
export async function pruneAttempts(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = await query(`DELETE FROM auth_attempts WHERE at < $1::timestamptz`, [cutoff]);
  return result.rowCount ?? 0;
}
