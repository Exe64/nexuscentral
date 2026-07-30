/**
 * Reddit rate budget (02-SPEC-ingestion.md 3.2).
 *
 * The `x-ratelimit-*` response headers are authoritative. The published limits
 * have changed before, so nothing here hardcodes a counter as the source of
 * truth -- only a provisional ceiling used before the first response arrives, and
 * discarded the moment it does.
 *
 * Two limits are enforced:
 *
 * - **Hard floor**: below `HARD_FLOOR` remaining, wait for the window to reset.
 *   This is the spec's rule and the last line of defence.
 * - **Utilisation cap**: never consume more than `MAX_UTILISATION` of the window.
 *   A single-user aggregator polling 60 subreddits every 15 minutes uses about
 *   4% of the budget; anything approaching half of it means something is wrong,
 *   and it is better to fall behind than to get the client id throttled.
 */

import { logger } from '../../logger.js';

/** Reddit's documented free tier, used only until the first response teaches us better. */
const PROVISIONAL_LIMIT = 100;
const PROVISIONAL_WINDOW_MS = 600_000;

export const HARD_FLOOR = 10;
export const MAX_UTILISATION = 0.5;

export interface BudgetSnapshot {
  /** Null until a response has been observed. */
  limit: number | null;
  remaining: number | null;
  /** Seconds until the window resets, or null when unknown. */
  resetIn: number | null;
  /** Fraction of the window consumed, 0..1. */
  utilisation: number | null;
  inFlight: number;
}

export interface BudgetClock {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const realClock: BudgetClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error('Aborted while waiting for the Reddit rate window to reset'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

const log = logger.child({ component: 'reddit-budget' });

export class RedditBudget {
  #limit: number | null = null;
  #remaining: number | null = null;
  #used: number | null = null;
  /** Epoch milliseconds at which the current window resets. */
  #resetAt: number | null = null;
  /**
   * Requests dispatched in the current window by us. Only consulted before the
   * first response; after that `#used` is authoritative.
   */
  #ownCount = 0;
  #inFlight = 0;
  /** Serialises admission so concurrent callers cannot all pass the same check. */
  #gate: Promise<void> = Promise.resolve();

  readonly #clock: BudgetClock;

  constructor(clock: BudgetClock = realClock) {
    this.#clock = clock;
  }

  /** Read the rate headers off a response. Call this for every Reddit response. */
  observe(headers: Headers): void {
    const used = parseNumeric(headers.get('x-ratelimit-used'));
    const remaining = parseNumeric(headers.get('x-ratelimit-remaining'));
    const reset = parseNumeric(headers.get('x-ratelimit-reset'));

    if (remaining !== null) this.#remaining = remaining;
    if (used !== null) this.#used = used;
    if (used !== null && remaining !== null) this.#limit = used + remaining;
    if (reset !== null) this.#resetAt = this.#clock.now() + reset * 1000;

    // Our own count only ever stood in for the real number.
    if (used !== null) this.#ownCount = used;
  }

  /**
   * Wait until a request may be dispatched, then account for it. The caller must
   * call `release()` when the request settles, whatever the outcome.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    // Chain onto the gate so two callers cannot both read a stale count.
    const previous = this.#gate;
    let releaseGate: () => void = () => undefined;
    this.#gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    try {
      await previous;
      await this.#admit(signal);
      this.#inFlight += 1;
      this.#ownCount += 1;
    } finally {
      releaseGate();
    }
  }

  release(): void {
    if (this.#inFlight > 0) this.#inFlight -= 1;
  }

  async #admit(signal?: AbortSignal): Promise<void> {
    // Up to two waits: one for the current window, and one more in case the
    // reset we waited for was itself stale. Beyond that, something is wrong with
    // the headers and blocking forever would be worse than proceeding.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.#expireWindow();

      const wait = this.#waitReason();
      if (wait === null) return;

      const delayMs = this.#msUntilReset();
      log.warn(
        { reason: wait, delayMs, ...this.snapshot() },
        'Holding Reddit requests until the rate window resets',
      );
      await this.#clock.sleep(delayMs, signal);
    }
  }

  /** Why the caller must wait, or null when it may proceed. */
  #waitReason(): 'hard_floor' | 'utilisation_cap' | null {
    if (this.#remaining !== null && this.#remaining - this.#inFlight < HARD_FLOOR) {
      return 'hard_floor';
    }

    const limit = this.#limit ?? PROVISIONAL_LIMIT;
    const consumed = (this.#used ?? this.#ownCount) + this.#inFlight;
    if (consumed >= limit * MAX_UTILISATION) return 'utilisation_cap';

    return null;
  }

  /** Clear the window once its reset time has passed. */
  #expireWindow(): void {
    if (this.#resetAt === null) {
      // No header seen yet: fall back to the documented window length so a long
      // run does not stay pinned to a provisional count forever.
      this.#resetAt = this.#clock.now() + PROVISIONAL_WINDOW_MS;
      return;
    }
    if (this.#clock.now() < this.#resetAt) return;

    this.#used = null;
    this.#remaining = null;
    this.#ownCount = 0;
    this.#resetAt = null;
  }

  #msUntilReset(): number {
    if (this.#resetAt === null) return PROVISIONAL_WINDOW_MS;
    // Add a second so we wake up after the window has actually rolled over.
    return Math.max(1000, this.#resetAt - this.#clock.now() + 1000);
  }

  snapshot(): BudgetSnapshot {
    const limit = this.#limit;
    const consumed = this.#used ?? this.#ownCount;
    const resetAt = this.#resetAt;

    return {
      limit,
      remaining: this.#remaining,
      resetIn:
        resetAt === null ? null : Math.max(0, Math.round((resetAt - this.#clock.now()) / 1000)),
      utilisation: limit === null || limit === 0 ? null : consumed / limit,
      inFlight: this.#inFlight,
    };
  }

  /** Test hook: forget everything observed so far. */
  reset(): void {
    this.#limit = null;
    this.#remaining = null;
    this.#used = null;
    this.#resetAt = null;
    this.#ownCount = 0;
    this.#inFlight = 0;
  }
}

function parseNumeric(raw: string | null): number | null {
  if (raw === null) return null;
  // Reddit sends these as floats ("4.0"), so parseInt would silently truncate.
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/** The shared singleton. One OAuth client id means one budget. */
export const redditBudget = new RedditBudget();
