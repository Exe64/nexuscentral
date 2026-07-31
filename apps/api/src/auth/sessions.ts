/**
 * Session storage.
 *
 * The cookie carries 32 random bytes; the database stores only their SHA-256.
 * A dump of `sessions` therefore yields nothing that can be replayed -- which is
 * the same reason `backup-db.sh` exists and the same reason it matters that it
 * does not need encrypting to be safe about this particular table.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';

/** Thirty days. Long, because the alternative is a single user logging in daily. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Past halfway, a request extends the session.
 *
 * Sliding, but not on every request: rewriting `expires_at` on each call would
 * mean a write per page load for no benefit.
 */
export const SESSION_RENEW_AFTER_MS = SESSION_TTL_MS / 2;

export interface SessionRecord {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  /** True for the session making the request, so the UI can say "this device". */
  current?: boolean;
}

interface SessionRow {
  id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  user_agent: string | null;
  ip: string | null;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export interface CreatedSession {
  /** Give this to the client once; it is not recoverable afterwards. */
  token: string;
  expiresAt: Date;
}

export async function createSession(meta: {
  userAgent?: string | null;
  ip?: string | null;
}): Promise<CreatedSession> {
  // 32 bytes from the CSPRNG: 256 bits of entropy, well past guessing.
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await query(
    `INSERT INTO sessions (token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4)`,
    [
      hashToken(token),
      expiresAt.toISOString(),
      meta.userAgent?.slice(0, 500) ?? null,
      meta.ip ?? null,
    ],
  );

  return { token, expiresAt };
}

export interface ResolvedSession {
  id: number;
  expiresAt: Date;
  /** Set when this lookup extended the session, so the caller can refresh the cookie. */
  renewedUntil?: Date;
}

/**
 * Look up a session by its token, sweeping it if expired.
 *
 * Returns null for absent, expired or malformed tokens alike -- the caller has no
 * use for the distinction and neither does an attacker.
 */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  if (token.length === 0 || token.length > 200) return null;

  const digest = hashToken(token);
  const { rows } = await query<{ id: string; expires_at: Date; token_hash: Buffer }>(
    `SELECT id, expires_at, token_hash FROM sessions WHERE token_hash = $1`,
    [digest],
  );

  const row = rows[0];
  if (row === undefined) return null;

  // The lookup above already matched on equality; this is belt and braces against
  // a future change that widens the query.
  if (row.token_hash.length !== digest.length || !timingSafeEqual(row.token_hash, digest)) {
    return null;
  }

  const expiresAt = new Date(row.expires_at);
  if (expiresAt.getTime() <= Date.now()) {
    await query(`DELETE FROM sessions WHERE id = $1`, [row.id]);
    return null;
  }

  const id = Number(row.id);

  // Sliding renewal, only past the halfway mark.
  const remaining = expiresAt.getTime() - Date.now();
  if (remaining < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
    const renewedUntil = new Date(Date.now() + SESSION_TTL_MS);
    await query(`UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1`, [
      row.id,
      renewedUntil.toISOString(),
    ]);
    return { id, expiresAt, renewedUntil };
  }

  await query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.id]);
  return { id, expiresAt };
}

export async function deleteSession(id: number): Promise<void> {
  await query(`DELETE FROM sessions WHERE id = $1`, [id]);
}

export async function deleteSessionByToken(token: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

/** Revoke everything except the caller's own session. Used after a password change. */
export async function deleteOtherSessions(keepId: number): Promise<number> {
  const result = await query(`DELETE FROM sessions WHERE id <> $1`, [keepId]);
  return result.rowCount ?? 0;
}

export async function deleteAllSessions(): Promise<number> {
  const result = await query(`DELETE FROM sessions`);
  return result.rowCount ?? 0;
}

export async function listSessions(currentId: number): Promise<SessionRecord[]> {
  const { rows } = await query<SessionRow>(
    `SELECT id, created_at, last_seen_at, expires_at, user_agent, host(ip) AS ip
       FROM sessions
      WHERE expires_at > now()
      ORDER BY last_seen_at DESC`,
  );

  return rows.map((row) => ({
    id: Number(row.id),
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    userAgent: row.user_agent,
    ip: row.ip,
    current: Number(row.id) === currentId,
  }));
}

/** Housekeeping. Cheap, index-backed, and safe to call whenever. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await query(`DELETE FROM sessions WHERE expires_at <= now()`);
  return result.rowCount ?? 0;
}
