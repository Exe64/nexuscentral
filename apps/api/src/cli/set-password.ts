/**
 * `pnpm set-password` -- set or reset the password, directly against the database.
 *
 * This is the way out of the corner the bootstrap variable can paint you into.
 * `AUTH_PASSWORD` is read exactly once, on the first boot that finds no stored
 * password; changing it afterwards does nothing, and a value mangled on its way
 * through Compose leaves you locked out with no way back. There has to be a door.
 *
 * It is also the better way to set the password in the first place, because
 * nothing is ever written to `.env`:
 *
 *   docker compose exec -it api node dist/cli/set-password.js
 *   printf '%s' "$PW" | docker compose exec -T api node dist/cli/set-password.js
 *
 * `node` rather than `pnpm`: the runtime image activates pnpm through corepack,
 * which wants to reach npmjs the first time a non-root user invokes it. A
 * password reset must not depend on the host having outbound network.
 *
 * Every existing session is revoked: if the reason for resetting is that someone
 * else has the old password, leaving their session alive defeats the reset.
 */

import { createInterface } from 'node:readline';
import { closePool } from '../db/pool.js';
import { credentialExists, setPassword } from '../auth/credential.js';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../auth/password.js';
import { deleteAllSessions } from '../auth/sessions.js';

/** Read a line from a TTY without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const rl = createInterface({ input, output, terminal: true });

    output.write(question);

    // readline echoes as you type; intercept the writes it makes for the answer.
    let muted = true;
    const realWrite = output.write.bind(output);
    (output as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) =>
      muted ? true : realWrite(chunk);

    rl.question('', (answer) => {
      muted = false;
      (output as unknown as { write: typeof realWrite }).write = realWrite;
      output.write('\n');
      rl.close();
      resolve(answer);
    });

    rl.on('error', reject);
  });
}

/** Read everything on stdin, for the piped case. */
function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  // Closed by the caller's finally; throwing here would print a stack trace for
  // what is a user error.
  throw new Error('__handled__');
}

async function main(): Promise<void> {
  const existed = await credentialExists();
  process.stdout.write(
    existed
      ? 'A password is already stored; this replaces it.\n'
      : 'No password is stored yet; this sets the first one.\n',
  );

  const interactive = process.stdin.isTTY === true;
  let password: string;

  if (interactive) {
    password = await promptHidden(`New password (at least ${MIN_PASSWORD_LENGTH} characters): `);
    const again = await promptHidden('Repeat it: ');
    if (password !== again) fail('The two entries do not match. Nothing was changed.');
  } else {
    // Trailing newline only -- a password may legitimately end in a space, and
    // trimming both ends would silently store something other than what was sent.
    password = (await readAllStdin()).replace(/\r?\n$/, '');
    if (password === '') {
      fail(
        'No password on stdin.\n' +
          '  Interactive:  docker compose exec -it api node dist/cli/set-password.js\n' +
          '  Piped:        printf \'%s\' "$PW" | docker compose exec -T api node dist/cli/set-password.js',
      );
    }
  }

  const problem = passwordProblem(password);
  if (problem !== null) fail(`${problem} Nothing was changed.`);

  await setPassword(password);
  const revoked = await deleteAllSessions();

  process.stdout.write(
    `Password ${existed ? 'changed' : 'set'}. ${revoked} session(s) revoked -- sign in again.\n`,
  );
  if (existed) {
    process.stdout.write('Remove AUTH_PASSWORD from .env if it is still there; it is ignored.\n');
  }
}

try {
  await main();
} catch (err) {
  if (!(err instanceof Error) || err.message !== '__handled__') {
    process.stderr.write(`Failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
} finally {
  await closePool();
}
