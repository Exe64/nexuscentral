import { describe, expect, it } from 'vitest';
import { redditFeedUrl } from '../../src/adapters/rss/reddit.js';

const NEW = 'https://www.reddit.com/r/selfhosted/new.rss';

describe('redditFeedUrl', () => {
  it('rewrites a bare subreddit URL to the chronological listing', () => {
    // The whole point: `/r/x` and `/r/x.rss` are the *hot* listing, which leads
    // with stickied posts months old and reorders as things trend.
    for (const input of [
      'https://www.reddit.com/r/selfhosted',
      'https://www.reddit.com/r/selfhosted/',
      'https://www.reddit.com/r/selfhosted.rss',
      'https://reddit.com/r/selfhosted',
      'https://old.reddit.com/r/selfhosted/',
    ]) {
      expect(redditFeedUrl(input), input).toBe(NEW);
    }
  });

  it('leaves a listing the user chose on purpose alone', () => {
    expect(redditFeedUrl('https://www.reddit.com/r/selfhosted/top')).toBe(
      'https://www.reddit.com/r/selfhosted/top.rss',
    );
    expect(redditFeedUrl('https://www.reddit.com/r/selfhosted/rising.rss')).toBe(
      'https://www.reddit.com/r/selfhosted/rising.rss',
    );
  });

  it('keeps the query, because it is what makes /top mean anything', () => {
    expect(redditFeedUrl('https://www.reddit.com/r/selfhosted/top?t=week')).toBe(
      'https://www.reddit.com/r/selfhosted/top.rss?t=week',
    );
  });

  it('puts the comments firehose suffix after a slash', () => {
    // Verified against Reddit: `/comments/.rss` is 200 and `/comments.rss` is a
    // thread id that does not exist. The difference is one character.
    expect(redditFeedUrl('https://www.reddit.com/r/selfhosted/comments/')).toBe(
      'https://www.reddit.com/r/selfhosted/comments/.rss',
    );
  });

  it('folds a multireddit into the one request it is', () => {
    // The reason this matters: Reddit's unauthenticated budget is per IP, so
    // three subreddits in one URL is three times the coverage for one call.
    expect(redditFeedUrl('https://www.reddit.com/r/selfhosted+homelab+docker')).toBe(
      'https://www.reddit.com/r/selfhosted+homelab+docker/new.rss',
    );
  });

  it('canonicalises the host so the same subreddit is one identifier', () => {
    // content_hash is built from kind|identifier: two spellings of the same
    // subreddit would otherwise store every post twice.
    const spellings = [
      'https://old.reddit.com/r/selfhosted',
      'https://np.reddit.com/r/selfhosted/',
      'https://reddit.com/r/selfhosted.rss',
      // Reddit treats names case-insensitively and `detectKind` lowercases them,
      // so this has to agree or the two paths disagree on one subreddit's identity.
      'https://www.reddit.com/r/SelfHosted/',
    ].map(redditFeedUrl);
    expect(new Set(spellings).size).toBe(1);
    expect(spellings[0]).toBe(NEW);
  });

  it('is idempotent, because the resolver runs it twice on the fallback path', () => {
    // `resolveInput` builds a feed URL and hands it to the RSS adapter, which
    // runs this again. A second pass that changed the URL would mean a source
    // whose identifier depends on how many times it was resolved.
    for (const input of [
      'https://www.reddit.com/r/selfhosted',
      'https://www.reddit.com/r/selfhosted/top?t=week',
      'https://www.reddit.com/r/selfhosted/comments/',
      'https://www.reddit.com/r/selfhosted+homelab',
    ]) {
      const once = redditFeedUrl(input);
      expect(once, input).not.toBeNull();
      expect(redditFeedUrl(once as string), input).toBe(once);
    }
  });

  it('declines a post permalink, which is a thread and not a listing', () => {
    expect(
      redditFeedUrl('https://www.reddit.com/r/selfhosted/comments/1vb74t1/another_victim/'),
    ).toBeNull();
  });

  it('declines anything that is not a subreddit listing', () => {
    for (const input of [
      'https://www.reddit.com/user/spez',
      'https://www.reddit.com/',
      'https://www.reddit.com/r/',
      'https://notreddit.com/r/selfhosted',
      'https://www.reddit.com/r/selfhosted/wiki',
      'https://reddit.com.evil.example/r/selfhosted',
      'not a url at all',
    ]) {
      expect(redditFeedUrl(input), input).toBeNull();
    }
  });

  it('declines names Reddit itself would reject, rather than building a URL that 404s forever', () => {
    expect(redditFeedUrl('https://www.reddit.com/r/ab')).toBeNull(); // under 3 characters
    expect(redditFeedUrl(`https://www.reddit.com/r/${'a'.repeat(22)}`)).toBeNull();
    expect(redditFeedUrl('https://www.reddit.com/r/self-hosted')).toBeNull(); // hyphen
    expect(redditFeedUrl('https://www.reddit.com/r/selfhosted+')).toBeNull(); // trailing join
  });
});
