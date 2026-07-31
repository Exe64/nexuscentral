import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, makeSource, recordingLogger } from '../helpers/fixtures.js';
import { stubFetch } from '../helpers/stub-fetch.js';
import { TOKEN_URL } from '../../src/adapters/reddit/auth.js';
import { OAUTH_BASE } from '../../src/adapters/reddit/client.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Generous rate headers, so the budget never interferes with a mapping test. */
const RATE_HEADERS = {
  ...JSON_HEADERS,
  'x-ratelimit-used': '4',
  'x-ratelimit-remaining': '596',
  'x-ratelimit-reset': '540',
};

const credentials = vi.hoisted(() => ({
  value: {
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    userAgent: 'nexuscentral/1.0 (self-hosted personal aggregator)',
    origin: 'settings' as const,
  } as {
    clientId: string;
    clientSecret: string;
    userAgent: string;
    origin: 'settings' | 'env';
  } | null,
}));

const cursor = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('../../src/db/settings.js', () => ({
  getRawSettings: vi.fn(async () => ({})),
  resolveRedditCredentials: vi.fn(() => credentials.value),
}));

vi.mock('../../src/db/items.js', () => ({
  newestFullnameForSource: vi.fn(async () => cursor.value),
}));

const { RedditAdapter, RedditNotConfiguredError, normalizeSubreddit } =
  await import('../../src/adapters/reddit/index.js');
const { RedditBudget } = await import('../../src/adapters/reddit/budget.js');
const { redditTokenCache } = await import('../../src/adapters/reddit/auth.js');

let restore: (() => void) | undefined;

beforeEach(() => {
  cursor.value = null;
  credentials.value = {
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    userAgent: 'nexuscentral/1.0 (self-hosted personal aggregator)',
    origin: 'settings',
  };
  // The token cache is a module singleton shared across tests.
  redditTokenCache.invalidate();
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

function ctx(identifier = 'nutanix') {
  const { logger, records } = recordingLogger();
  return {
    records,
    context: {
      source: makeSource({ kind: 'reddit', identifier, title: `r/${identifier}` }),
      signal: new AbortController().signal,
      logger,
    },
  };
}

const TOKEN_ROUTE = {
  [TOKEN_URL]: { body: fixture('reddit', 'token.json'), headers: JSON_HEADERS },
};

describe('normalizeSubreddit', () => {
  it('accepts every form the spec lists', () => {
    expect(normalizeSubreddit('nutanix')).toBe('nutanix');
    expect(normalizeSubreddit('r/Nutanix')).toBe('nutanix');
    expect(normalizeSubreddit('/r/nutanix')).toBe('nutanix');
    expect(normalizeSubreddit('https://www.reddit.com/r/nutanix/')).toBe('nutanix');
    expect(normalizeSubreddit('https://old.reddit.com/r/nutanix/new/?sort=hot')).toBe('nutanix');
  });
});

describe('RedditAdapter.fetch', () => {
  it('calls the OAuth host, never the unauthenticated .json endpoints', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    await new RedditAdapter().fetch(ctx().context);

    const dataRequests = stub.requests.filter((request) => request.url !== TOKEN_URL);
    for (const request of dataRequests) {
      expect(request.url.startsWith('https://oauth.reddit.com')).toBe(true);
      expect(request.headers['authorization']).toMatch(/^Bearer /);
      // These are IP-tracked and capped near 10 QPM on a datacentre address.
      expect(request.url).not.toContain('www.reddit.com');
      expect(request.url).not.toContain('.json');
    }
  });

  it('asks for 100 items, because one request returns up to 100 regardless', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    await new RedditAdapter().fetch(ctx().context);

    expect(stub.requests.some((r) => r.url.includes('limit=100'))).toBe(true);
  });

  it('maps a self post completely', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const result = await new RedditAdapter().fetch(ctx().context);
    const post = result.items.find((item) => item.guid === 't3_1p9y77');

    expect(post).toMatchObject({
      url: 'https://reddit.com/r/nutanix/comments/1p9y77/aos_72_upgrade_notes_from_a_40node_cluster/',
      title: 'AOS 7.2 upgrade notes from a 40-node cluster',
      author: 'storage_admin',
      engagementScore: 214,
      engagementComments: 37,
      guid: 't3_1p9y77',
    });
    // created_utc is seconds, not milliseconds: 1785398400 -> 2026-07-30T08:00Z.
    expect(post?.publishedAt.toISOString()).toBe('2026-07-30T08:00:00.000Z');
    // selftext becomes the summary, with markup stripped and entities decoded.
    expect(post?.summary).toBe(
      'We hit two issues worth writing down. First, the pre-check & timeout.',
    );
  });

  it('uses the target URL as the summary for a link post', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const result = await new RedditAdapter().fetch(ctx().context);
    const linkPost = result.items.find((item) => item.guid === 't3_1p9x02');

    // The permalink is the item URL; where it points is the useful extra fact.
    expect(linkPost?.url).toContain('reddit.com/r/nutanix/comments/1p9x02');
    expect(linkPost?.summary).toBe('https://portal.nutanix.com/advisory/cve-2026-31337');
  });

  it('skips stickied posts, which would otherwise top every poll forever', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const result = await new RedditAdapter().fetch(ctx().context);

    expect(result.items.map((item) => item.guid)).not.toContain('t3_1p9zab');
    expect(result.items.map((item) => item.title)).not.toContain('Monthly discussion thread');
  });

  it('keeps a zero-score post rather than treating 0 as absent', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const result = await new RedditAdapter().fetch(ctx().context);
    const fresh = result.items.find((item) => item.guid === 't3_1p9w41');

    expect(fresh?.engagementScore).toBe(0);
    expect(fresh?.engagementComments).toBe(0);
  });

  it('skips a post with no permalink and says so', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const { context, records } = ctx();
    const result = await new RedditAdapter().fetch(context);

    // Four usable posts out of five children, one of which is stickied.
    expect(result.items).toHaveLength(3);
    expect(records.some((r) => r.level === 'warn' && /unusable/.test(r.msg ?? ''))).toBe(true);
  });

  it('passes the newest stored fullname as a before cursor', async () => {
    cursor.value = 't3_1p9y77';
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1&before=t3_1p9y77`]: {
        body: fixture('reddit', 'listing-empty.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const result = await new RedditAdapter().fetch(ctx().context);

    expect(stub.requests.some((r) => r.url.includes('before=t3_1p9y77'))).toBe(true);
    // Nothing new is the normal answer to a cursor query. Counting it towards
    // silent-death detection would flag every quiet subreddit.
    expect(result.emptyIsExpected).toBe(true);
  });

  it('treats an empty first listing as suspicious, not expected', async () => {
    cursor.value = null;
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-empty.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const result = await new RedditAdapter().fetch(ctx().context);

    // With no cursor, an empty listing means the subreddit really is empty.
    expect(result.emptyIsExpected).toBeUndefined();
  });

  it('refuses to poll at all when credentials are missing', async () => {
    credentials.value = null;
    const stub = stubFetch({});
    restore = stub.restore;

    await expect(new RedditAdapter().fetch(ctx().context)).rejects.toBeInstanceOf(
      RedditNotConfiguredError,
    );
    // Not one request was made.
    expect(stub.requests).toHaveLength(0);
  });

  it('retries once after a 401 with a fresh token', async () => {
    let listingCalls = 0;
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: () => {
        listingCalls += 1;
        return listingCalls === 1
          ? { status: 401, body: '{}', headers: RATE_HEADERS }
          : { body: fixture('reddit', 'listing-new.json'), headers: RATE_HEADERS };
      },
    });
    restore = stub.restore;

    const result = await new RedditAdapter().fetch(ctx().context);

    expect(result.items).toHaveLength(3);
    // A revoked token must not fail the whole poll.
    expect(stub.requests.filter((r) => r.url === TOKEN_URL)).toHaveLength(2);
  });

  it('reports a private or banned subreddit distinctly from a missing one', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        status: 403,
        body: '{}',
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    await expect(new RedditAdapter().fetch(ctx().context)).rejects.toThrow(/private, quarantined/);
  });

  it('reads the rate headers off every response, including errors', async () => {
    const budget = new RedditBudget();
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        status: 500,
        body: '{}',
        headers: {
          ...JSON_HEADERS,
          'x-ratelimit-used': '61',
          'x-ratelimit-remaining': '39',
          'x-ratelimit-reset': '120',
        },
      },
    });
    restore = stub.restore;

    const { redditGet } = await import('../../src/adapters/reddit/client.js');
    await expect(
      redditGet('/r/nutanix/new?limit=100&raw_json=1', {
        credentials: credentials.value!,
        budget,
      }),
    ).rejects.toThrow();

    // A failed request still consumed budget, so the headers still matter.
    expect(budget.snapshot()).toMatchObject({ limit: 100, remaining: 39 });
  });
});

describe('RedditAdapter.resolve', () => {
  it('confirms the subreddit via /about and returns real sample items', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/about?raw_json=1`]: {
        body: fixture('reddit', 'about.json'),
        headers: RATE_HEADERS,
      },
      [`${OAUTH_BASE}/r/nutanix/new?limit=5&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const [candidate, ...rest] = await new RedditAdapter().resolve('/r/Nutanix');

    expect(rest).toHaveLength(0);
    expect(candidate).toMatchObject({
      kind: 'reddit',
      identifier: 'nutanix',
      title: 'r/nutanix',
      siteUrl: 'https://reddit.com/r/nutanix',
      iconUrl: 'https://styles.redditmedia.com/t5_2v9wq/styles/communityIcon_abc123.png',
    });
    expect(candidate?.sampleItems).toHaveLength(3);
    // The stickied post is excluded from the preview too.
    expect(candidate?.sampleItems.map((item) => item.guid)).not.toContain('t3_1p9zab');
  });

  it('still offers the source when the sample listing fails', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/about?raw_json=1`]: {
        body: fixture('reddit', 'about.json'),
        headers: RATE_HEADERS,
      },
      [`${OAUTH_BASE}/r/nutanix/new?limit=5&raw_json=1`]: {
        status: 500,
        body: '{}',
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const [candidate] = await new RedditAdapter().resolve('nutanix');

    // The subreddit exists; a failed preview must not block adding it.
    expect(candidate?.identifier).toBe('nutanix');
    expect(candidate?.sampleItems).toEqual([]);
  });

  it('rejects an invalid name before spending a request', async () => {
    const stub = stubFetch({});
    restore = stub.restore;

    await expect(new RedditAdapter().resolve('not a subreddit!')).rejects.toThrow(
      /not a valid subreddit/,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('reports a subreddit that does not exist', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/ghost/about?raw_json=1`]: {
        status: 404,
        body: '{}',
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    await expect(new RedditAdapter().resolve('r/ghost')).rejects.toThrow(/may not exist/);
  });

  it('explains that credentials are missing rather than failing obscurely', async () => {
    credentials.value = null;
    const stub = stubFetch({});
    restore = stub.restore;

    await expect(new RedditAdapter().resolve('nutanix')).rejects.toThrow(/Settings/);
  });
});
