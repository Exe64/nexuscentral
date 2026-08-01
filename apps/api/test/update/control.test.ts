/**
 * The application's half of the update handshake: it writes a request and reads
 * a state. It never runs anything, and these tests are partly there to keep it
 * that way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test' as const,
    LOG_LEVEL: 'silent' as const,
    LOG_PRETTY: false,
    UPDATE_CONTROL_DIR: undefined as string | undefined,
  },
}));

vi.mock('../../src/config/env.js', () => ({
  env: mocks.env,
  isProduction: false,
  isTest: true,
}));

const { REQUEST_STALE_MS, isUpdateRunConfigured, requestUpdate, updateRun, UpdateRunError } =
  await import('../../src/update/control.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nc-update-'));
  mocks.env.UPDATE_CONTROL_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeState = (state: unknown): Promise<void> =>
  writeFile(join(dir, 'state.json'), JSON.stringify(state), 'utf8');

describe('when no control directory is configured', () => {
  beforeEach(() => {
    mocks.env.UPDATE_CONTROL_DIR = undefined;
  });

  it('reports unavailable rather than idle', async () => {
    // Idle would mean "ready to update", and pressing the button would then fail
    // for a reason the UI never mentioned.
    expect((await updateRun()).state).toBe('unavailable');
    expect(isUpdateRunConfigured()).toBe(false);
  });

  it('refuses a request instead of writing somewhere arbitrary', async () => {
    await expect(requestUpdate()).rejects.toBeInstanceOf(UpdateRunError);
  });
});

describe('an empty control directory', () => {
  it('is idle', async () => {
    expect((await updateRun()).state).toBe('idle');
  });
});

describe('requesting an update', () => {
  it('writes a request the agent can find', async () => {
    const run = await requestUpdate();

    expect(run.state).toBe('requested');
    const raw = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')) as {
      requestedAt: string;
    };
    expect(Date.parse(raw.requestedAt)).toBeGreaterThan(0);
  });

  it('carries nothing that could be executed', async () => {
    await requestUpdate();

    // The request is a trigger, not a parameter: deploy.sh always deploys the
    // head of main. Adding a field here that the agent passed to a command is
    // the mistake this asserts against.
    const raw = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')) as object;
    expect(Object.keys(raw)).toEqual(['requestedAt']);
  });

  it('refuses while one is already queued', async () => {
    await requestUpdate();
    await expect(requestUpdate()).rejects.toMatchObject({ reason: 'already_running' });
  });

  it('refuses while the agent is deploying', async () => {
    await writeState({
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      fromSha: 'abc1234',
      toSha: null,
      exitCode: null,
      message: null,
    });

    await expect(requestUpdate()).rejects.toMatchObject({ reason: 'already_running' });
  });

  it('allows a new one after the last finished', async () => {
    await writeState({
      state: 'succeeded',
      startedAt: '2026-07-31T10:00:00Z',
      finishedAt: '2026-07-31T10:05:00Z',
      fromSha: 'abc1234',
      toSha: 'def5678',
      exitCode: 0,
      message: 'Deployed.',
    });

    expect((await requestUpdate()).state).toBe('requested');
  });
});

describe('reading what the agent did', () => {
  it('reports a finished run', async () => {
    await writeState({
      state: 'succeeded',
      startedAt: '2026-07-31T10:00:00Z',
      finishedAt: '2026-07-31T10:05:00Z',
      fromSha: 'abc1234',
      toSha: 'def5678',
      exitCode: 0,
      message: 'Deployed abc1234 -> def5678.',
    });

    const run = await updateRun();

    expect(run.state).toBe('succeeded');
    expect(run.toSha).toBe('def5678');
  });

  it('includes the log tail on a failure', async () => {
    await writeFile(join(dir, 'update.log'), 'migration failed\n', 'utf8');
    await writeState({
      state: 'failed',
      startedAt: '2026-07-31T10:00:00Z',
      finishedAt: '2026-07-31T10:05:00Z',
      fromSha: 'abc1234',
      toSha: 'abc1234',
      exitCode: 1,
      message: 'deploy.sh exited 1.',
    });

    expect((await updateRun()).logTail).toContain('migration failed');
  });

  it('withholds the log on success, where it is only noise', async () => {
    await writeFile(join(dir, 'update.log'), 'three minutes of build output\n', 'utf8');
    await writeState({
      state: 'succeeded',
      startedAt: '2026-07-31T10:00:00Z',
      finishedAt: '2026-07-31T10:05:00Z',
      fromSha: 'abc1234',
      toSha: 'def5678',
      exitCode: 0,
      message: null,
    });

    expect((await updateRun()).logTail).toBeNull();
  });

  it('survives a half-written state file', async () => {
    // The agent renames into place to prevent exactly this, but a truncated file
    // must not take the settings page down with it.
    await writeFile(join(dir, 'state.json'), '{"state":"succ', 'utf8');

    const run = await updateRun();

    expect(run.state).toBe('failed');
    expect(run.message).toBe('unreadable_state');
  });

  it('lets a pending request outrank the last finished run', async () => {
    await writeState({
      state: 'succeeded',
      startedAt: '2026-07-31T10:00:00Z',
      finishedAt: '2026-07-31T10:05:00Z',
      fromSha: 'abc1234',
      toSha: 'def5678',
      exitCode: 0,
      message: null,
    });
    await requestUpdate();

    // Otherwise pressing Update now shows "Update complete" from an hour ago.
    expect((await updateRun()).state).toBe('requested');
  });
});

describe('a request nothing picks up', () => {
  it('says so instead of waiting for ever', async () => {
    // This is what an agent that was never installed looks like, and it is the
    // most likely way the feature appears broken.
    const old = new Date(Date.now() - REQUEST_STALE_MS - 1000).toISOString();
    await writeFile(join(dir, 'request.json'), JSON.stringify({ requestedAt: old }), 'utf8');

    expect((await updateRun()).state).toBe('unclaimed');
  });

  it('is still merely queued a moment after being written', async () => {
    await requestUpdate();
    expect((await updateRun()).state).toBe('requested');
  });
});
