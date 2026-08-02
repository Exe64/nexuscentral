/**
 * The application's side of the update handshake.
 *
 * It writes a request file and reads a state file. It does not run anything, and
 * it holds no privilege it did not already have -- see deploy/update-agent.sh
 * for why that boundary is where it is.
 *
 * Every failure here is reported as a state, never thrown. The panel that shows
 * this is the one a user opens when something is already wrong.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { UpdateRun } from '@nexuscentral/shared';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'update-control' });

/**
 * How long a request may sit unclaimed before the UI stops saying "queued".
 *
 * The timer fires every minute. Past this, the honest reading is not "still
 * waiting" but "nothing is listening" -- which is what an uninstalled agent
 * looks like, and the single most likely way this feature appears broken.
 */
export const REQUEST_STALE_MS = 5 * 60 * 1000;

/** Enough to see the failure, small enough not to ship a build log to a browser. */
const LOG_TAIL_BYTES = 8 * 1024;

const stateSchema = z.object({
  state: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  fromSha: z.string().nullable(),
  toSha: z.string().nullable(),
  exitCode: z.number().nullable(),
  message: z.string().nullable(),
});

const requestSchema = z.object({ requestedAt: z.string() });

function paths(dir: string) {
  return {
    request: join(dir, 'request.json'),
    state: join(dir, 'state.json'),
    log: join(dir, 'update.log'),
  };
}

/** Missing is the normal case for all three files, so it is not an error. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn({ err, path }, 'Could not read update control file');
    return null;
  }
}

function idle(): UpdateRun {
  return {
    state: 'idle',
    requestedAt: null,
    startedAt: null,
    finishedAt: null,
    fromSha: null,
    toSha: null,
    message: null,
    logTail: null,
  };
}

function unavailable(message: string): UpdateRun {
  return { ...idle(), state: 'unavailable', message };
}

export function isUpdateRunConfigured(): boolean {
  return env.UPDATE_CONTROL_DIR !== undefined;
}

/**
 * What the agent is doing, if anything.
 *
 * A pending request outranks a finished state: the state file is whatever the
 * last run left behind, and "succeeded an hour ago" must not be shown while a
 * new request is queued.
 */
export async function updateRun(): Promise<UpdateRun> {
  const dir = env.UPDATE_CONTROL_DIR;
  if (dir === undefined) {
    return unavailable('not_configured');
  }

  const p = paths(dir);
  const [rawRequest, rawState] = await Promise.all([
    readIfPresent(p.request),
    readIfPresent(p.state),
  ]);

  if (rawRequest !== null) {
    const parsed = safeParse(requestSchema, rawRequest);
    const requestedAt = parsed?.requestedAt ?? new Date().toISOString();
    const waited = Date.now() - Date.parse(requestedAt);
    return {
      ...idle(),
      // Not a different state: the request is genuinely still queued. What
      // changes is that the UI can stop pretending the wait is normal.
      state: Number.isFinite(waited) && waited > REQUEST_STALE_MS ? 'unclaimed' : 'requested',
      requestedAt,
    };
  }

  if (rawState === null) return idle();

  const parsed = safeParse(stateSchema, rawState);
  if (parsed === null) return { ...idle(), state: 'failed', message: 'unreadable_state' };

  return {
    state: parsed.state,
    requestedAt: null,
    startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt,
    fromSha: parsed.fromSha,
    toSha: parsed.toSha,
    message: parsed.message,
    // While it runs and when it failed. Running is the case someone is actually
    // watching: deploy.sh takes minutes, and "Deploying..." with nothing under it
    // is indistinguishable from a deploy that hung. The log names the step.
    //
    // Withheld on success, where three minutes of build output says nothing that
    // "Update complete" did not.
    logTail:
      parsed.state === 'failed' || parsed.state === 'running' ? await readLogTail(p.log) : null,
  };
}

function safeParse<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function readLogTail(path: string): Promise<string | null> {
  const raw = await readIfPresent(path);
  if (raw === null) return null;
  return raw.length <= LOG_TAIL_BYTES ? raw : raw.slice(-LOG_TAIL_BYTES);
}

export class UpdateRunError extends Error {
  readonly reason: 'not_configured' | 'already_running' | 'write_failed';

  constructor(reason: UpdateRunError['reason'], message: string) {
    super(message);
    this.name = 'UpdateRunError';
    this.reason = reason;
  }
}

/**
 * Ask the host agent to deploy.
 *
 * The file carries a timestamp and nothing else that is acted on. deploy.sh
 * always deploys the head of main, so there is no target to pass -- and nothing
 * in this file ever reaches a command line.
 */
export async function requestUpdate(): Promise<UpdateRun> {
  const dir = env.UPDATE_CONTROL_DIR;
  if (dir === undefined) {
    throw new UpdateRunError('not_configured', 'In-app updates are not configured on this host.');
  }

  const current = await updateRun();
  if (current.state === 'running' || current.state === 'requested') {
    throw new UpdateRunError('already_running', 'An update is already in progress.');
  }

  const p = paths(dir);
  const requestedAt = new Date().toISOString();

  try {
    await mkdir(dir, { recursive: true });
    // Written then renamed: the agent polls this path, and it must never observe
    // a half-written file it would then treat as a valid request.
    const tmp = `${p.request}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ requestedAt }, null, 2)}\n`, 'utf8');
    await rename(tmp, p.request);
  } catch (err) {
    log.error({ err, dir }, 'Could not write the update request');
    throw new UpdateRunError(
      'write_failed',
      'Could not write the update request. Check that the control directory is writable.',
    );
  }

  return { ...idle(), state: 'requested', requestedAt };
}
