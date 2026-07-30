/**
 * One poll of one source: fetch, normalise, deduplicate, insert, record health.
 *
 * Kept free of any HTTP-layer import. The worker and the API server share a
 * process by default, but no worker code may depend on the HTTP layer
 * (02-SPEC-ingestion.md 1) -- that is what keeps them separable.
 */

import type { FetchResult, Source } from '@feedhub/shared';
import { getAdapter } from '../adapters/registry.js';
import { insertItems } from '../db/items.js';
import {
  EMPTY_RUNS_BEFORE_ALERT,
  getConditionalState,
  getSource,
  markPollFailure,
  markPollStarted,
  markPollSuccess,
} from '../db/sources.js';
import { logger as rootLogger } from '../logger.js';
import { HttpError as HttpClientError } from '../lib/http.js';

/** The runner enforces the adapter contract's 30s ceiling. */
export const FETCH_TIMEOUT_MS = 30_000;

export interface PollOutcome {
  sourceId: number;
  /**
   * `ok`           -- items returned
   * `not_modified` -- HTTP 304
   * `no_new_items` -- zero items, and the adapter says that is the steady state
   * `empty`        -- zero items where that is a symptom; counts towards silent death
   */
  status: 'ok' | 'not_modified' | 'no_new_items' | 'empty' | 'failed' | 'skipped';
  itemCount: number;
  newCount: number;
  durationMs: number;
  httpStatus?: number;
  error?: string;
  /** True when this failure crossed the threshold and deactivated the source. */
  deactivated?: boolean;
  /** True when a silently-empty source has now failed often enough to report. */
  silentDeath?: boolean;
}

/**
 * Poll one source. Never throws: a failing source must not abort the cycle for
 * the others, and every failure path has to leave health bookkeeping behind.
 */
export async function pollSource(sourceId: number): Promise<PollOutcome> {
  const startedAt = Date.now();
  const log = rootLogger.child({ job: 'poll:source', sourceId });

  const source = await getSource(sourceId);
  if (source === null) {
    // The source was deleted between enqueue and execution. Not an error.
    const outcome: PollOutcome = {
      sourceId,
      status: 'skipped',
      itemCount: 0,
      newCount: 0,
      durationMs: Date.now() - startedAt,
      error: 'source no longer exists',
    };
    log.info(outcome, 'Poll skipped');
    return outcome;
  }

  const adapter = getAdapter(source.kind);
  if (adapter === undefined) {
    // A source of a kind this build cannot poll. Record it so the UI can explain
    // why nothing is arriving, rather than leaving the source looking healthy.
    await markPollStarted(sourceId);
    const failure = await markPollFailure(sourceId, `No adapter for kind "${source.kind}"`);
    const outcome: PollOutcome = {
      sourceId,
      status: 'failed',
      itemCount: 0,
      newCount: 0,
      durationMs: Date.now() - startedAt,
      error: `No adapter for kind "${source.kind}"`,
      deactivated: failure.deactivated,
    };
    log.warn(outcome, 'Poll failed');
    return outcome;
  }

  await markPollStarted(sourceId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const conditional = await getConditionalState(sourceId);
    const result: FetchResult = await adapter.fetch({
      source,
      signal: controller.signal,
      logger: log,
      conditional,
    });

    if (result.notModified === true) {
      // 304: legitimately zero items, so it must not count as a silent failure.
      await markPollSuccess(sourceId, { outcome: 'unchanged' });
      const outcome: PollOutcome = {
        sourceId,
        status: 'not_modified',
        itemCount: 0,
        newCount: 0,
        durationMs: Date.now() - startedAt,
        httpStatus: 304,
      };
      log.info({ ...outcome, kind: source.kind }, 'Poll complete');
      return outcome;
    }

    const inserted = await insertItems(source, result.items);

    // Three cases, not two. A cursor-based adapter reporting nothing new is not
    // the same as a feed that has gone silent, and conflating them would flag
    // every quiet subreddit.
    const outcomeKind: 'items' | 'empty' | 'unchanged' =
      result.items.length > 0 ? 'items' : result.emptyIsExpected === true ? 'unchanged' : 'empty';

    const consecutiveEmpty = await markPollSuccess(sourceId, {
      etag: result.etag,
      lastModified: result.lastModified,
      outcome: outcomeKind,
    });

    // An adapter that fails by returning a well-formed empty feed is the Nitter
    // failure mode; do not treat empty as success just because HTTP was 200.
    const silentDeath = outcomeKind === 'empty' && consecutiveEmpty >= EMPTY_RUNS_BEFORE_ALERT;

    const outcome: PollOutcome = {
      sourceId,
      status:
        outcomeKind === 'items' ? 'ok' : outcomeKind === 'unchanged' ? 'no_new_items' : 'empty',
      itemCount: result.items.length,
      newCount: inserted.insertedIds.length,
      durationMs: Date.now() - startedAt,
      httpStatus: 200,
      ...(silentDeath ? { silentDeath: true } : {}),
    };

    if (silentDeath) {
      log.warn(
        { ...outcome, kind: source.kind, consecutiveEmpty },
        'Source has returned an empty feed repeatedly; it may have died silently',
      );
    } else {
      log.info({ ...outcome, kind: source.kind }, 'Poll complete');
    }

    return outcome;
  } catch (err) {
    const message = describeError(err);
    const failure = await markPollFailure(sourceId, message);

    const outcome: PollOutcome = {
      sourceId,
      status: 'failed',
      itemCount: 0,
      newCount: 0,
      durationMs: Date.now() - startedAt,
      error: message,
      ...(err instanceof HttpClientError && err.status !== undefined
        ? { httpStatus: err.status }
        : {}),
      deactivated: failure.deactivated,
    };

    if (failure.deactivated) {
      log.error(
        { ...outcome, kind: source.kind, consecutiveFailures: failure.consecutiveFailures },
        'Source deactivated after repeated failures; a permanently dead feed should stop consuming budget',
      );
    } else {
      log.warn(
        { ...outcome, kind: source.kind, consecutiveFailures: failure.consecutiveFailures },
        'Poll failed',
      );
    }

    return outcome;
  } finally {
    clearTimeout(timeout);
  }
}

function describeError(err: unknown): string {
  if (err instanceof HttpClientError) {
    return err.status === undefined ? `${err.kind}: ${err.message}` : `HTTP ${err.status}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Convenience for tests and for `POST /api/sources/:id/poll`. */
export type { Source };
