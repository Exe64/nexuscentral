/**
 * "Is this deployment the newest commit on main?"
 *
 * One request to `GET /repos/{repo}/commits?sha=main&per_page=1`, and a
 * comparison against the sha this build was deployed from.
 *
 * Measured before choosing: `/compare/{sha}...main` answers the same question
 * *and* counts the commits between, but it carries the full patch for every
 * changed file -- 132 KB across five commits of this repository, and it grows
 * with how far behind you are. That makes it heaviest exactly when you check.
 * The commits endpoint is 6 KB flat, and the commit count is not worth twenty
 * times the payload. The compare *page* is linked instead, so the diff is one
 * click away and costs this app nothing.
 *
 * Unauthenticated: the repository is public and GitHub allows 60 requests an
 * hour per IP. Nothing here needs a token, so nothing here stores one.
 */

import { z } from 'zod';
import type { UpdateStatus } from '@nexuscentral/shared';
import { env } from '../config/env.js';
import { httpRequest, HttpError } from '../lib/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'update' });

/** Long enough that idle browsing never spends the budget; short enough to be current. */
export const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * A forced check still cannot run more often than this. The refresh button is
 * one click and the hourly budget is 60; without a floor, a bored user locks
 * themselves out of the check for the rest of the hour.
 */
export const FORCE_FLOOR_MS = 60 * 1000;

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 512 * 1024;

/** Only the fields used. GitHub sends far more, and none of it is our business. */
const commitSchema = z.object({
  sha: z.string().min(7),
  commit: z.object({
    message: z.string(),
    committer: z.object({ date: z.string() }).partial().optional(),
    author: z.object({ date: z.string() }).partial().optional(),
  }),
});

const listSchema = z.array(commitSchema).min(1);

interface CacheEntry {
  status: UpdateStatus;
  /** Serve from cache until this instant. */
  until: number;
  /** Wall-clock of the fetch, so the force floor measures from the request. */
  at: number;
}

let cache: CacheEntry | null = null;

/** Test seam. The module-level cache would otherwise leak between cases. */
export function resetUpdateCache(): void {
  cache = null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * True when `current` names the same commit as `latest`.
 *
 * By prefix, not equality: deploy.sh passes `git rev-parse --short HEAD`, which
 * is seven characters, and GitHub answers with all forty. Comparing them
 * directly would report every deployment as out of date.
 */
export function isSameCommit(current: string, latest: string): boolean {
  const a = current.toLowerCase();
  const b = latest.toLowerCase();
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

function unknown(reason: string, current: string | null): UpdateStatus {
  return {
    state: 'unknown',
    current,
    latest: null,
    latestSubject: null,
    latestAt: null,
    compareUrl: null,
    checkedAt: new Date().toISOString(),
    reason,
  };
}

/**
 * How long to stay quiet after GitHub says the budget is spent.
 *
 * `x-ratelimit-reset` is epoch seconds. Retrying before it just collects more
 * 403s, and each one still counts as a request against the next window.
 */
function rateLimitedUntil(headers: Headers): number | null {
  if (headers.get('x-ratelimit-remaining') !== '0') return null;
  const reset = Number.parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
  if (!Number.isFinite(reset)) return null;
  return reset * 1000;
}

async function fetchLatest(): Promise<UpdateStatus> {
  const current = env.GIT_SHA ?? null;
  const url = `https://api.github.com/repos/${env.UPDATE_REPO}/commits?sha=main&per_page=1`;

  const response = await httpRequest(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    // The caller is a person waiting on a page. Retrying a rate-limit refusal
    // three times over half a minute helps nobody and spends the same budget.
    retries: 0,
  });

  if (!response.ok) {
    const limited = rateLimitedUntil(response.headers);
    if (limited !== null) {
      const status = unknown('rate_limited', current);
      cache = { status, until: limited, at: Date.now() };
      return status;
    }
    throw new HttpError('status', `GitHub answered ${response.status}`, url, response.status);
  }

  const parsed = listSchema.safeParse(JSON.parse(response.body));
  if (!parsed.success) {
    return unknown('unreadable_response', current);
  }

  const head = parsed.data[0]!;
  const latest = head.sha;
  const date = head.commit.committer?.date ?? head.commit.author?.date ?? null;

  return {
    state:
      current === null
        ? 'unknown'
        : isSameCommit(current, latest)
          ? 'up_to_date'
          : 'update_available',
    current,
    latest: shortSha(latest),
    // First line only: a body of five paragraphs does not belong in a status line.
    latestSubject: head.commit.message.split('\n')[0]?.trim() ?? null,
    latestAt: date,
    compareUrl:
      current === null
        ? `https://github.com/${env.UPDATE_REPO}/commits/main`
        : `https://github.com/${env.UPDATE_REPO}/compare/${current}...main`,
    checkedAt: new Date().toISOString(),
    reason: current === null ? 'no_build_sha' : null,
  };
}

/**
 * The current status, from cache when it is fresh.
 *
 * Never throws: a failed check is a state to display, not an error to propagate.
 * The one thing it must never do is answer `up_to_date` on a failure.
 */
export async function updateStatus({ force = false } = {}): Promise<UpdateStatus> {
  if (!env.UPDATE_CHECK_ENABLED) {
    return {
      ...unknown('disabled', env.GIT_SHA ?? null),
      state: 'disabled',
      reason: null,
    };
  }

  const now = Date.now();
  if (cache !== null) {
    // A rate-limit backoff outranks `force`. Retrying inside the window collects
    // another 403, and that 403 counts against the next window too -- so the
    // refresh button would dig the hole deeper the more it is pressed.
    if (cache.status.reason === 'rate_limited' && now < cache.until) return cache.status;

    const withinTtl = now < cache.until;
    const tooSoonToForce = now - cache.at < FORCE_FLOOR_MS;
    if (force ? tooSoonToForce : withinTtl) return cache.status;
  }

  try {
    const status = await fetchLatest();
    // `fetchLatest` sets its own, longer, cache entry when rate-limited.
    if (status.reason !== 'rate_limited') {
      cache = { status, until: now + CACHE_TTL_MS, at: now };
    }
    return status;
  } catch (err) {
    log.warn({ err }, 'Update check failed');
    const status = unknown('unreachable', env.GIT_SHA ?? null);
    // Cached like any other answer, so a GitHub outage does not turn every page
    // load into a ten-second wait on a request that will fail again.
    cache = { status, until: now + CACHE_TTL_MS, at: now };
    return status;
  }
}
