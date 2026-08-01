import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubFetch } from '../helpers/stub-fetch.js';

// No Reddit credentials anywhere: the state every instance is in until OAuth
// registration comes back, which takes weeks.
vi.mock('../../src/db/settings.js', () => ({
  getRawSettings: vi.fn(async () => ({})),
  resolveRedditCredentials: vi.fn(() => null),
  resolveNitterBaseUrls: vi.fn(() => ({ urls: [], origin: 'settings' as const })),
}));

const { resolveInput } = await import('../../src/adapters/registry.js');

const ATOM = { 'content-type': 'application/atom+xml; charset=UTF-8' };
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>newest submissions : SteamDeck</title>
  <entry>
    <id>t3_1sey9ch</id>
    <title>Docked performance regression after the latest update</title>
    <link href="https://www.reddit.com/r/steamdeck/comments/1vc3lbw/docked/"/>
    <updated>2026-07-31T17:18:00+00:00</updated>
  </entry>
</feed>`;

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('resolveInput without Reddit credentials', () => {
  it('falls back to the public feed instead of refusing', async () => {
    const feedUrl = 'https://www.reddit.com/r/steamdeck/new.rss';
    const stub = stubFetch({ [feedUrl]: { body: FEED, headers: ATOM } });
    restore = stub.restore;

    const candidates = await resolveInput('https://www.reddit.com/r/SteamDeck/');

    // The kind is `rss` and that is honest: no credentials means no engagement
    // data, and the source should not pretend to be something it cannot be.
    expect(candidates[0]).toMatchObject({ kind: 'rss', identifier: feedUrl });
    expect(candidates[0]?.sampleItems[0]?.engagementScore ?? null).toBeNull();
  });

  it('accepts the bare r/name form, which is not a URL at all', async () => {
    const feedUrl = 'https://www.reddit.com/r/steamdeck/new.rss';
    const stub = stubFetch({ [feedUrl]: { body: FEED, headers: ATOM } });
    restore = stub.restore;

    await expect(resolveInput('r/SteamDeck')).resolves.toHaveLength(1);
  });

  it('keeps the listing and the query the user chose', async () => {
    // `detectKind` reduces a URL to a bare subreddit name, so a naive fallback
    // would silently turn "top posts this week" into "newest posts".
    const feedUrl = 'https://www.reddit.com/r/steamdeck/top.rss?t=week';
    const stub = stubFetch({ [feedUrl]: { body: FEED, headers: ATOM } });
    restore = stub.restore;

    const candidates = await resolveInput('https://www.reddit.com/r/steamdeck/top?t=week');

    expect(candidates[0]?.identifier).toBe(feedUrl);
  });

  it('still reports a genuine upstream failure rather than swallowing it', async () => {
    const stub = stubFetch({
      'https://www.reddit.com/r/steamdeck/new.rss': { status: 429, body: '' },
    });
    restore = stub.restore;

    // The fallback must not turn every Reddit problem into "no feed found".
    await expect(resolveInput('r/steamdeck')).rejects.toMatchObject({ status: 429 });
  });
});
