import { beforeEach, describe, expect, it } from 'vitest';
import { HARD_FLOOR, MAX_UTILISATION, RedditBudget } from '../../src/adapters/reddit/budget.js';

/**
 * The acceptance criterion is "Reddit sources poll without ever exceeding 50% of
 * the rate budget", so the utilisation cap is what these tests are really about.
 * The clock is injected: a real `sleep` would make this suite take ten minutes.
 */

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
  sleeps: number[];
}

function fakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  const sleeps: number[] = [];

  return {
    now: () => current,
    // Sleeping advances time, which is what makes the reset actually happen.
    sleep: (ms: number) => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
    sleeps,
  };
}

function headers(used: number, remaining: number, reset: number): Headers {
  return new Headers({
    'x-ratelimit-used': String(used),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(reset),
  });
}

let clock: FakeClock;
let budget: RedditBudget;

beforeEach(() => {
  clock = fakeClock();
  budget = new RedditBudget(clock);
});

describe('observing the rate headers', () => {
  it('derives the limit from used + remaining rather than assuming one', () => {
    // The published limits have changed before, so the headers are authoritative.
    budget.observe(headers(4, 96, 540));

    expect(budget.snapshot()).toMatchObject({ limit: 100, remaining: 96, resetIn: 540 });
  });

  it('parses the float form Reddit actually sends', () => {
    budget.observe(
      new Headers({
        'x-ratelimit-used': '4.0',
        'x-ratelimit-remaining': '596.0',
        'x-ratelimit-reset': '412.0',
      }),
    );

    expect(budget.snapshot()).toMatchObject({ limit: 600, remaining: 596 });
  });

  it('ignores a response with no rate headers instead of resetting what it knows', () => {
    budget.observe(headers(10, 90, 300));
    budget.observe(new Headers());

    expect(budget.snapshot()).toMatchObject({ limit: 100, remaining: 90 });
  });

  it('reports utilisation, which is the number the budget rule is about', () => {
    budget.observe(headers(25, 75, 300));
    expect(budget.snapshot().utilisation).toBeCloseTo(0.25);
  });
});

describe('the utilisation cap', () => {
  it('lets a normal polling load straight through', async () => {
    // 60 subreddits every 15 minutes is roughly 4 requests a minute.
    budget.observe(headers(4, 96, 540));

    for (let i = 0; i < 10; i += 1) {
      await budget.acquire();
      budget.release();
    }

    expect(clock.sleeps).toHaveLength(0);
  });

  it('holds requests once half the window is consumed', async () => {
    budget.observe(headers(50, 50, 300));

    await budget.acquire();
    budget.release();

    // It waited rather than proceeding at exactly 50%.
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(300_000);
  });

  it('never lets observed usage pass the cap across a whole window', async () => {
    // Simulate a server that counts every request, and check we stop ourselves
    // before reaching MAX_UTILISATION of a 100-request window.
    let used = 0;
    const limit = 100;
    let sleptOnce = false;

    for (let i = 0; i < 80; i += 1) {
      await budget.acquire();
      used += 1;
      budget.release();
      budget.observe(headers(used, limit - used, 600));

      if (clock.sleeps.length > 0 && !sleptOnce) {
        sleptOnce = true;
        // The window reset while we slept, so the server's counter restarts.
        used = 0;
      }
    }

    expect(sleptOnce).toBe(true);
    expect(used).toBeLessThanOrEqual(limit * MAX_UTILISATION);
  });

  it('applies a provisional ceiling before any header has been seen', async () => {
    // Nothing observed yet: the documented free tier of 100 stands in, so a burst
    // on a cold start cannot blow the budget before the first response arrives.
    // Reaching exactly 50 is allowed; the criterion is not *exceeding* half.
    for (let i = 0; i < 50; i += 1) {
      await budget.acquire();
      budget.release();
    }
    expect(clock.sleeps).toHaveLength(0);

    await budget.acquire();
    budget.release();
    expect(clock.sleeps).toHaveLength(1);
  });

  it('discards the provisional ceiling as soon as a real limit arrives', async () => {
    for (let i = 0; i < 20; i += 1) {
      await budget.acquire();
      budget.release();
    }

    // The real window turns out to be much larger than the provisional guess.
    budget.observe(headers(20, 580, 600));

    for (let i = 0; i < 50; i += 1) {
      await budget.acquire();
      budget.release();
    }

    expect(clock.sleeps).toHaveLength(0);
    expect(budget.snapshot().limit).toBe(600);
  });
});

describe('the hard floor', () => {
  it('waits when remaining drops below the floor even if utilisation looks fine', async () => {
    // A huge window with almost nothing left: utilisation is low, but proceeding
    // would run the client id into the wall.
    budget.observe(headers(1, HARD_FLOOR - 1, 120));

    await budget.acquire();
    budget.release();

    expect(clock.sleeps).toHaveLength(1);
  });

  it('accounts for requests already in flight', async () => {
    budget.observe(headers(1, HARD_FLOOR + 1, 120));

    // Two in flight brings the effective remaining under the floor.
    await budget.acquire();
    await budget.acquire();
    await budget.acquire();

    expect(clock.sleeps.length).toBeGreaterThan(0);
  });
});

describe('window rollover', () => {
  it('resumes without waiting once the window has reset', async () => {
    budget.observe(headers(50, 50, 60));

    // The reset passes on its own, without us having slept.
    clock.advance(61_000);

    await budget.acquire();
    budget.release();

    expect(clock.sleeps).toHaveLength(0);
  });

  it('sleeps past the reset boundary rather than waking up exactly on it', async () => {
    budget.observe(headers(50, 50, 30));

    await budget.acquire();
    budget.release();

    // A wake-up on the exact boundary races the server's own clock.
    expect(clock.sleeps[0]).toBeGreaterThan(30_000);
  });

  it('gives up waiting after two rounds rather than blocking forever', async () => {
    // A server reporting a stale reset must not deadlock the poller.
    budget.observe(
      new Headers({
        'x-ratelimit-used': '99',
        'x-ratelimit-remaining': '1',
        'x-ratelimit-reset': '0',
      }),
    );

    await budget.acquire();
    budget.release();

    expect(clock.sleeps.length).toBeLessThanOrEqual(2);
  });
});

describe('concurrent admission', () => {
  it('counts requests in flight, so concurrent callers cannot all read a stale count', async () => {
    budget.observe(headers(45, 55, 300));

    // Five concurrent acquires against a 100-request window already 45 deep take
    // it to exactly the cap. Without in-flight accounting every one of them would
    // read "45 used" and sail through, and so would the sixth.
    await Promise.all(Array.from({ length: 5 }, () => budget.acquire()));

    expect(budget.snapshot().inFlight).toBe(5);
    expect(clock.sleeps).toHaveLength(0);

    // The sixth is over the line and has to wait.
    await budget.acquire();
    expect(clock.sleeps).toHaveLength(1);
  });

  it('releases in-flight accounting even when a request fails', () => {
    budget.observe(headers(1, 99, 300));
    budget.release();
    budget.release();

    // Never goes negative, whatever the caller does.
    expect(budget.snapshot().inFlight).toBe(0);
  });
});
