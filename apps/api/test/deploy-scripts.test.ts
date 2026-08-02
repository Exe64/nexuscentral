/**
 * The shipped shell scripts are executable.
 *
 * Not a hypothetical. `deploy/update-agent.sh` shipped as 100644, so the systemd
 * unit failed 203/EXEC once a minute, the update request was never claimed, and
 * the UI sat on "Update requested" for ever with nothing anywhere saying why.
 *
 * The throwaway harness that exercised the agent copied it and chmod'd the copy,
 * so it passed on a file it had made executable itself. This reads the mode of
 * the file the repository actually ships.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Read the mode git records, not the mode on disk.
 *
 * A clone applies what git stored; a local `chmod` that was never staged would
 * make an on-disk check pass here and fail on the server, which is the failure
 * this test exists to prevent.
 */
function gitFileModes(): Map<string, string> {
  const output = execFileSync('git', ['ls-files', '-s', '--', '*.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  const modes = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^(\d{6}) [0-9a-f]+ \d+\t(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) modes.set(match[2], match[1]);
  }
  return modes;
}

describe('shell scripts in the repository', () => {
  const modes = gitFileModes();

  it('finds them at all, so a vacuous pass cannot hide the rest', () => {
    expect(modes.size).toBeGreaterThan(0);
    expect([...modes.keys()]).toContain('deploy/update-agent.sh');
  });

  it('are all executable', () => {
    const notExecutable = [...modes].filter(([, mode]) => mode !== '100755').map(([path]) => path);

    expect(notExecutable).toEqual([]);
  });
});
