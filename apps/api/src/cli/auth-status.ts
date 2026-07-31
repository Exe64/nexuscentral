/**
 * `pnpm auth-status` -- why can I not sign in?
 *
 * Answers the questions that matter when a login is being refused, without
 * printing anything that would help someone who should not be reading it: no
 * hash, no token, no password. Just when things happened and how they were set.
 *
 * The AUTH_PASSWORD comparison is the useful one. `docker compose` expands `$` in
 * .env values, so a password containing one arrives truncated and the stored hash
 * is for something the user never typed.
 */

import { closePool, query } from '../db/pool.js';
import { env } from '../config/env.js';
import { verifyPassword } from '../auth/password.js';
import { MAX_PER_IP, MAX_GLOBAL, WINDOW_MS } from '../auth/attempts.js';

interface CredentialRow {
  updated_at: Date;
  scheme: string;
}

async function main(): Promise<void> {
  const out = (line = ''): void => void process.stdout.write(`${line}\n`);

  out('=== credential ===');
  const { rows: creds } = await query<CredentialRow>(
    `SELECT updated_at, split_part(password_hash, '$', 1) AS scheme FROM auth_credential`,
  );
  const cred = creds[0];

  if (cred === undefined) {
    out('  none stored -- the API refuses to serve in this state.');
    out('  Set one:  docker compose exec -it api node dist/cli/set-password.js');
  } else {
    out(`  stored     yes (${cred.scheme})`);
    out(`  last set   ${cred.updated_at.toISOString()}`);
  }

  out();
  out('=== AUTH_PASSWORD in this container ===');
  const supplied = env.AUTH_PASSWORD;
  if (supplied === undefined) {
    out('  not set (correct once a password is stored)');
  } else {
    // Length and shape only. Enough to spot truncation, nothing more.
    out(`  set        yes, ${supplied.length} characters`);
    out('');
    out(`  Compare ${supplied.length} with the length of what you actually wrote in .env.`);
    out('  If it is shorter, Compose expanded a $ on the way in: it substitutes');
    out('  $name and ${name} in .env values, so `secret$word` arrives as `secret`.');
    out('  The container cannot see this for itself -- the $ never reached it --');
    out('  which is why this prints a length instead of claiming to know.');
    out('  Docker also warns on the host: "The \\"word\\" variable is not set".');
    if (cred !== undefined) {
      const matches = await verifyPassword(
        supplied,
        (await query<{ password_hash: string }>(`SELECT password_hash FROM auth_credential`))
          .rows[0]?.password_hash ?? '',
      );
      out(
        matches
          ? '  matches    yes -- the stored password is the one in AUTH_PASSWORD'
          : '  matches    NO -- the stored password is NOT the one in AUTH_PASSWORD.',
      );
      if (!matches) {
        out('             It was stored on an earlier boot from a different value, or');
        out('             changed since. AUTH_PASSWORD is only read when none is stored.');
        out('             Reset it:  docker compose exec -it api node dist/cli/set-password.js');
      }
    }
  }

  out();
  out('=== sessions ===');
  const { rows: sess } = await query<{ live: number; expired: number }>(
    `SELECT count(*) FILTER (WHERE expires_at > now())::int  AS live,
            count(*) FILTER (WHERE expires_at <= now())::int AS expired
       FROM sessions`,
  );
  out(`  live       ${sess[0]?.live ?? 0}`);
  out(`  expired    ${sess[0]?.expired ?? 0}`);

  out();
  out('=== login attempts ===');
  const { rows: att } = await query<{ failed: number; total: number; last: Date | null }>(
    `SELECT count(*) FILTER (WHERE successful = false AND at > now() - $1::interval)::int AS failed,
            count(*)::int AS total,
            max(at)       AS last
       FROM auth_attempts`,
    [`${Math.round(WINDOW_MS / 1000)} seconds`],
  );
  const row = att[0];
  out(`  failed in the last ${Math.round(WINDOW_MS / 60000)} min: ${row?.failed ?? 0}`);
  out(`  recorded, all time:      ${row?.total ?? 0}`);
  out(`  most recent:             ${row?.last?.toISOString() ?? 'never'}`);

  if ((row?.failed ?? 0) >= MAX_GLOBAL) {
    out(`  LOCKED OUT globally (limit ${MAX_GLOBAL}). Clear it with:`);
    out(
      "    docker compose exec -T postgres psql -U nexuscentral -d nexuscentral -c 'DELETE FROM auth_attempts'",
    );
  } else if ((row?.failed ?? 0) >= MAX_PER_IP) {
    out(`  possibly locked out per address (limit ${MAX_PER_IP} per IP)`);
  }

  out();
  out('=== proxy ===');
  out(`  TRUST_PROXY ${env.TRUST_PROXY ?? '(unset)'}`);
  if (env.TRUST_PROXY === undefined) {
    out('  Unset behind a proxy means every request looks like one address, so the');
    out('  per-IP limit becomes a single shared bucket.');
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`Failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
