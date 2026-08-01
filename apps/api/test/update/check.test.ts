/**
 * The update check: what it asks GitHub, and what it refuses to claim.
 *
 * The rule the whole feature rests on: no failure may ever be reported as
 * `up_to_date`. A wrong "Update available" costs a click; a wrong "Up to date"
 * means running a build with a known bug and believing otherwise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HttpModule from '../../src/lib/http.js';

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test' as const,
    LOG_LEVEL: 'silent' as const,
    LOG_PRETTY: false,
    GIT_SHA: 'ab12cd3' as string | undefined,
    UPDATE_REPO: 'Exe64/nexuscentral',
    UPDATE_CHECK_ENABLED: true,
  },
  httpRequest: vi.fn(),
}));

vi.mock('../../src/config/env.js', () => ({
  env: mocks.env,
  isProduction: false,
  isTest: true,
}));

vi.mock('../../src/lib/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpModule>()),
  httpRequest: mocks.httpRequest,
}));

const { CACHE_TTL_MS, FORCE_FLOOR_MS, isSameCommit, resetUpdateCache, updateStatus } =
  await import('../../src/update/check.js');

/** The full forty characters, as GitHub answers. `ab12cd3` is its short form. */
const FULL_SHA = 'ab12cd3ef4567890123456789012345678901234';
const OTHER_SHA = '9f8e7d6c5b4a39281726354453627180a9b8c7d6';

function commitsResponse(sha: string, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    url: 'https://api.github.com/',
    contentType: 'application/json',
    body: JSON.stringify([
      {
        sha,
        commit: {
          message: 'feat: something\n\nA body that must not reach the status line.',
          committer: { date: '2026-07-30T10:00:00Z' },
        },
      },
    ]),
    ...overrides,
  };
}

beforeEach(() => {
  resetUpdateCache();
  mocks.httpRequest.mockReset();
  mocks.env.GIT_SHA = 'ab12cd3';
  mocks.env.UPDATE_CHECK_ENABLED = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-31T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isSameCommit', () => {
  it('matches a short sha against the full one', () => {
    // deploy.sh passes `rev-parse --short` (seven characters) and GitHub answers
    // with forty. Comparing them with `===` would call every deployment stale.
    expect(isSameCommit('ab12cd3', FULL_SHA)).toBe(true);
    expect(isSameCommit(FULL_SHA, 'ab12cd3')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSameCommit('AB12CD3', FULL_SHA)).toBe(true);
  });

  it('does not match a different commit', () => {
    expect(isSameCommit('ab12cd3', OTHER_SHA)).toBe(false);
  });
});

describe('updateStatus', () => {
  it('asks for one commit on main and nothing else', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(FULL_SHA));

    await updateStatus();

    const [url, options] = mocks.httpRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://api.github.com/repos/Exe64/nexuscentral/commits?sha=main&per_page=1');
    // `per_page=1` is the whole cost control: the compare endpoint answers the
    // same question with every patch attached.
    expect(url).not.toContain('/compare/');
    expect(options['retries']).toBe(0);
  });

  it('reports up to date when the deployed sha is the head', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(FULL_SHA));

    const status = await updateStatus();

    expect(status.state).toBe('up_to_date');
    expect(status.latest).toBe('ab12cd3');
  });

  it('reports an update when the head has moved', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(OTHER_SHA));

    const status = await updateStatus();

    expect(status.state).toBe('update_available');
    expect(status.compareUrl).toBe('https://github.com/Exe64/nexuscentral/compare/ab12cd3...main');
  });

  it('keeps only the first line of the commit message', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(OTHER_SHA));

    const status = await updateStatus();

    expect(status.latestSubject).toBe('feat: something');
  });

  it('cannot tell when the build carries no sha', async () => {
    mocks.env.GIT_SHA = undefined;
    mocks.httpRequest.mockResolvedValue(commitsResponse(FULL_SHA));

    const status = await updateStatus();

    expect(status.state).toBe('unknown');
    expect(status.reason).toBe('no_build_sha');
  });

  it('cannot tell when GitHub is unreachable, and does not throw', async () => {
    mocks.httpRequest.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const status = await updateStatus();

    // The load-bearing assertion of the whole feature.
    expect(status.state).toBe('unknown');
    expect(status.state).not.toBe('up_to_date');
    expect(status.reason).toBe('unreachable');
  });

  it('cannot tell when the answer does not parse', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(FULL_SHA, { body: '{"message":"nope"}' }));

    const status = await updateStatus();

    expect(status.state).toBe('unknown');
    expect(status.reason).toBe('unreadable_response');
  });

  it('cannot tell when GitHub answers a bad status', async () => {
    mocks.httpRequest.mockResolvedValue(
      commitsResponse(FULL_SHA, { ok: false, status: 404, body: '' }),
    );

    const status = await updateStatus();

    expect(status.state).toBe('unknown');
    expect(status.reason).toBe('unreachable');
  });

  it('is disabled without making a request', async () => {
    mocks.env.UPDATE_CHECK_ENABLED = false;

    const status = await updateStatus();

    expect(status.state).toBe('disabled');
    expect(mocks.httpRequest).not.toHaveBeenCalled();
  });
});

describe('the cache', () => {
  it('makes one request however many times it is asked', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(FULL_SHA));

    await updateStatus();
    await updateStatus();
    await updateStatus();

    expect(mocks.httpRequest).toHaveBeenCalledTimes(1);
  });

  it('asks again once the entry is stale', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(FULL_SHA));

    await updateStatus();
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    await updateStatus();

    expect(mocks.httpRequest).toHaveBeenCalledTimes(2);
  });

  it('caches a failure too, so an outage is not a request per page load', async () => {
    mocks.httpRequest.mockRejectedValue(new Error('down'));

    await updateStatus();
    await updateStatus();

    expect(mocks.httpRequest).toHaveBeenCalledTimes(1);
  });

  it('lets a forced check skip the cache', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(FULL_SHA));

    await updateStatus();
    vi.advanceTimersByTime(FORCE_FLOOR_MS + 1);
    await updateStatus({ force: true });

    expect(mocks.httpRequest).toHaveBeenCalledTimes(2);
  });

  it('floors a forced check, so the button cannot spend the hourly budget', async () => {
    mocks.httpRequest.mockResolvedValue(commitsResponse(FULL_SHA));

    await updateStatus();
    for (let i = 0; i < 20; i += 1) await updateStatus({ force: true });

    // GitHub allows 60 an hour unauthenticated. Twenty clicks in a row must not
    // spend a third of that.
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1);
  });
});

describe('the GitHub rate limit', () => {
  function exhausted(resetAtMs: number) {
    return commitsResponse(FULL_SHA, {
      ok: false,
      status: 403,
      body: '',
      headers: new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(resetAtMs / 1000)),
      }),
    });
  }

  it('says so rather than calling it unreachable', async () => {
    mocks.httpRequest.mockResolvedValue(exhausted(Date.now() + 15 * 60_000));

    const status = await updateStatus();

    expect(status.state).toBe('unknown');
    expect(status.reason).toBe('rate_limited');
  });

  it('stays quiet until the window resets, even when forced', async () => {
    const resetAt = Date.now() + 15 * 60_000;
    mocks.httpRequest.mockResolvedValue(exhausted(resetAt));

    await updateStatus();
    vi.advanceTimersByTime(FORCE_FLOOR_MS + 1);
    await updateStatus({ force: true });

    // Retrying before the reset collects another 403, and that 403 still counts
    // against the next window.
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1);
  });
});
