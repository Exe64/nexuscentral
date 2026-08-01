/**
 * Subreddits, resolved to the right Atom feed.
 *
 * Reddit's Data API needs OAuth credentials whose registration is no longer
 * self-service (docs/00-CONTEXT.md), so a subreddit added before those arrive
 * goes through the RSS adapter instead. Two things decide whether that works,
 * and neither is visible in the URL a user pastes:
 *
 * - **`/r/x.rss` is the *hot* listing.** It leads with stickied posts that can be
 *   months old and it reorders as things trend -- the wrong shape for an
 *   aggregator, which wants a chronological tail it can deduplicate against.
 *   `/r/x/new.rss` is that. A bare subreddit URL is rewritten to it; a listing
 *   the user typed on purpose is left alone.
 * - **A multireddit costs one request, not N.** `/r/a+b+c/new.rss` is a single
 *   fetch. Reddit's unauthenticated budget is per IP and tight -- measured at
 *   roughly one request per 30-60s, with `x-ratelimit-remaining` at 0.0 after a
 *   single call -- so folding several subreddits into one URL is the difference
 *   between polling comfortably and being throttled.
 *
 * Matching the URL here, instead of letting the generic resolver fetch
 * reddit.com and read its `<link rel="alternate">`, also keeps that budget from
 * being spent on a megabyte of HTML that may not advertise the feed at all.
 *
 * What this cannot give back is engagement: the Atom carries no `ups` and no
 * `num_comments`, so items scored from it have no engagement term. That is the
 * standing reason to move a source to the `reddit` kind once credentials exist.
 */

/** Reddit serves the same feeds on each of these; the output is always canonical. */
const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
]);

/** Reddit's own rule: 3-21 characters, letters, digits and underscores. */
const SUBREDDIT = /^[A-Za-z0-9_]{3,21}$/;

/** Listings with a feed of their own. `comments` is the per-comment firehose. */
const LISTINGS = new Set(['new', 'hot', 'top', 'rising', 'controversial', 'comments']);

/**
 * The canonical feed URL for a Reddit listing, or null if this is not a Reddit
 * URL we can turn into one.
 *
 * Takes an already-normalised absolute URL -- `normalizeInputUrl` runs first, so
 * a pasted `reddit.com/r/x` arrives here with its scheme.
 */
export function redditFeedUrl(normalizedUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(normalizedUrl);
  } catch {
    return null;
  }

  if (!REDDIT_HOSTS.has(url.hostname.toLowerCase())) return null;

  // `.rss` is a format suffix on the last segment, not a segment of its own.
  const segments = url.pathname
    .replace(/\.rss$/i, '')
    .split('/')
    .filter((segment) => segment.length > 0);

  if (segments[0]?.toLowerCase() !== 'r') return null;

  // Lowercased, matching `detectKind` and the bare identifier the data model
  // stores (01-SPEC-data-model.md 1.2). Reddit treats names case-insensitively,
  // so `/r/SteamDeck` and `/r/steamdeck` are one subreddit -- and since
  // `content_hash` is built from the identifier, keeping both spellings would
  // store every post in it twice.
  const name = segments[1]?.toLowerCase();
  if (name === undefined || !isSubredditName(name)) return null;

  // Anything deeper than `/r/<name>/<listing>` is a post permalink or a search,
  // not a listing. `/r/x/comments/1abc/title` is one specific thread.
  if (segments.length > 3) return null;

  const listing = segments[2]?.toLowerCase();
  if (listing !== undefined && !LISTINGS.has(listing)) return null;

  const path =
    listing === undefined
      ? `/r/${name}/new.rss`
      : listing === 'comments'
        ? // The one listing whose suffix hangs off a trailing slash. Verified:
          // `/r/x/comments/.rss` is 200, and it is not the same URL as
          // `/r/x/comments.rss`, which is a thread id that does not exist.
          `/r/${name}/comments/.rss`
        : `/r/${name}/${listing}.rss`;

  // Keep the query: `?t=week` is what makes `/top` mean anything, and `limit`
  // is how a busy subreddit is kept inside one poll.
  return `https://www.reddit.com${path}${url.search}`;
}

/** Multireddits join subreddits with `+`, and every part has to be a real name. */
function isSubredditName(raw: string): boolean {
  const parts = raw.split('+');
  return parts.length <= MAX_MULTIREDDIT_PARTS && parts.every((part) => SUBREDDIT.test(part));
}

/**
 * Reddit truncates very long multireddit URLs. The cap is well above what fits
 * in one readable source name, and its job is only to stop a pathological input
 * from being turned into a URL that will 400 on every poll forever.
 */
const MAX_MULTIREDDIT_PARTS = 25;
