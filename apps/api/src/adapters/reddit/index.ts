/**
 * The Reddit adapter (02-SPEC-ingestion.md 3.2).
 *
 * One request returns up to 100 items, so the cost of a source is one HTTP call
 * per poll regardless of how busy the subreddit is. Comment trees would cost one
 * request per post, which is why comments are a non-goal.
 */

import type {
  FetchContext,
  FetchResult,
  NormalizedItem,
  ResolvedSource,
  SourceAdapter,
} from '@nexuscentral/shared';
import { getRawSettings, resolveRedditCredentials } from '../../db/settings.js';
import { newestFullnameForSource } from '../../db/items.js';
import { SUMMARY_MAX_LENGTH, toPlainTitle, toSummary } from '../../lib/text.js';
import { redditGet, RedditApiError } from './client.js';

/** A listing returns up to 100 items for one request; always ask for all of them. */
const LISTING_LIMIT = 100;

export const SAMPLE_ITEM_COUNT = 3;

/**
 * Reddit's own rules: 3-21 characters, letters, digits and underscores. Checked
 * before a request so an obvious typo does not spend budget.
 */
const SUBREDDIT_PATTERN = /^[a-z0-9_]{2,21}$/;

interface RedditPost {
  name?: string;
  permalink?: string;
  url?: string;
  title?: string;
  selftext?: string;
  author?: string;
  created_utc?: number;
  ups?: number;
  num_comments?: number;
  stickied?: boolean;
  is_self?: boolean;
  subreddit?: string;
  over_18?: boolean;
  thumbnail?: string;
  preview?: { images?: { source?: { url?: string } }[] };
}

interface RedditListing {
  kind?: string;
  data?: {
    after?: string | null;
    before?: string | null;
    children?: { kind?: string; data?: RedditPost }[];
  };
}

interface RedditAbout {
  data?: {
    display_name?: string;
    title?: string;
    public_description?: string;
    subscribers?: number;
    icon_img?: string;
    community_icon?: string;
    url?: string;
    over18?: boolean;
  };
}

export class RedditNotConfiguredError extends Error {
  constructor() {
    super(
      'Reddit credentials are not configured. Add a client id and secret in Settings, or set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.',
    );
    this.name = 'RedditNotConfiguredError';
  }
}

export class RedditAdapter implements SourceAdapter {
  readonly kind = 'reddit' as const;

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { source, signal, logger } = ctx;

    const credentials = resolveRedditCredentials(await getRawSettings());
    if (credentials === null) throw new RedditNotConfiguredError();

    // `before` fetches only what is newer than the last post we stored. Reddit
    // stores the fullname in `name` (e.g. t3_abc123); it lives in items.raw.
    const before = await newestFullnameForSource(source.id);

    const params = new URLSearchParams({ limit: String(LISTING_LIMIT), raw_json: '1' });
    if (before !== null) params.set('before', before);

    const listing = await redditGet<RedditListing>(
      `/r/${source.identifier}/new?${params.toString()}`,
      { credentials, signal },
    );

    const children = listing.data?.children ?? [];
    const items: NormalizedItem[] = [];
    let stickiedSkipped = 0;
    let unusable = 0;

    for (const child of children) {
      const post = child.data;
      if (post === undefined) {
        unusable += 1;
        continue;
      }
      // A stickied post is a moderator announcement pinned indefinitely; it would
      // reappear at the top of every poll.
      if (post.stickied === true) {
        stickiedSkipped += 1;
        continue;
      }

      const item = toNormalizedItem(post);
      if (item === null) {
        unusable += 1;
        continue;
      }
      items.push(item);
    }

    if (unusable > 0) {
      logger.warn({ sourceId: source.id, unusable }, 'Reddit posts were unusable and were skipped');
    }
    if (stickiedSkipped > 0) {
      logger.debug({ sourceId: source.id, stickiedSkipped }, 'Skipped stickied Reddit posts');
    }

    return {
      items,
      // With a cursor, nothing new is the normal answer; without one, an empty
      // listing means the subreddit really is empty, which is worth noticing.
      ...(before !== null && items.length === 0 ? { emptyIsExpected: true } : {}),
    };
  }

  /**
   * Accepts `nutanix`, `r/nutanix`, `/r/nutanix` or a full reddit URL, then
   * confirms the subreddit exists via `/r/{name}/about`.
   */
  async resolve(input: string): Promise<ResolvedSource[]> {
    const credentials = resolveRedditCredentials(await getRawSettings());
    if (credentials === null) throw new RedditNotConfiguredError();

    const name = normalizeSubreddit(input);
    if (!SUBREDDIT_PATTERN.test(name)) {
      throw new RedditApiError(
        `"${input}" is not a valid subreddit name. Use letters, digits and underscores.`,
        400,
      );
    }

    const about = await redditGet<RedditAbout>(`/r/${name}/about?raw_json=1`, { credentials });
    const data = about.data;
    if (data === undefined || data.display_name === undefined) {
      throw new RedditApiError(`r/${name} does not exist or is not readable.`, 404);
    }

    // One extra request buys real sample items, which is what makes committing to
    // a source feel safe. It is a rounding error against the budget.
    let sampleItems: NormalizedItem[] = [];
    try {
      const listing = await redditGet<RedditListing>(
        `/r/${name}/new?limit=${SAMPLE_ITEM_COUNT + 2}&raw_json=1`,
        { credentials },
      );
      sampleItems = (listing.data?.children ?? [])
        .map((child) => child.data)
        .filter((post): post is RedditPost => post !== undefined && post.stickied !== true)
        .map(toNormalizedItem)
        .filter((item): item is NormalizedItem => item !== null)
        .slice(0, SAMPLE_ITEM_COUNT);
    } catch {
      // The subreddit exists; a failed sample must not block adding it.
      sampleItems = [];
    }

    const iconUrl = pickIcon(data.icon_img, data.community_icon);

    return [
      {
        kind: 'reddit',
        identifier: data.display_name.toLowerCase(),
        title: `r/${data.display_name}`,
        siteUrl: `https://reddit.com/r/${data.display_name}`,
        ...(iconUrl === undefined ? {} : { iconUrl }),
        sampleItems,
      },
    ];
  }
}

/** Canonical identifier: bare, lowercase, no `r/` prefix. */
export function normalizeSubreddit(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/(?:www\.|old\.|new\.|np\.)?reddit\.com/i, '')
    .replace(/^\/+/, '')
    .replace(/^r\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\?.*$/, '')
    .toLowerCase();
}

function toNormalizedItem(post: RedditPost): NormalizedItem | null {
  const permalink = post.permalink;
  const title = post.title === undefined ? '' : toPlainTitle(post.title);

  // A post with no permalink cannot be linked to and so cannot be stored.
  if (permalink === undefined || permalink === '') return null;

  const url = `https://reddit.com${permalink}`;

  // A self post's body is the summary; a link post's target is the most useful
  // thing to show instead.
  const summary =
    post.selftext !== undefined && post.selftext.trim() !== ''
      ? toSummary(post.selftext, SUMMARY_MAX_LENGTH)
      : post.url !== undefined && post.url !== url
        ? post.url
        : undefined;

  const createdUtc = post.created_utc;
  const publishedAt =
    typeof createdUtc === 'number' && Number.isFinite(createdUtc)
      ? new Date(createdUtc * 1000)
      : new Date();

  const imageUrl = previewImage(post);

  return {
    url,
    title: title === '' ? url : title,
    ...(summary === undefined ? {} : { summary }),
    ...(post.author === undefined || post.author === '' ? {} : { author: post.author }),
    publishedAt,
    ...(typeof post.ups === 'number' ? { engagementScore: post.ups } : {}),
    ...(typeof post.num_comments === 'number' ? { engagementComments: post.num_comments } : {}),
    ...(imageUrl === undefined ? {} : { imageUrl }),
    ...(post.name === undefined || post.name === '' ? {} : { guid: post.name }),
    raw: post,
  };
}

/**
 * `thumbnail` is a string field that is usually not a URL.
 *
 * Reddit puts sentinels in it -- `self`, `default`, `nsfw`, `spoiler`, `image`,
 * the empty string -- and a naive read renders them as broken images. The real
 * preview lives in `preview.images[].source.url`, HTML-escaped, so `&amp;` has
 * to come back out or the signed URL fails its own signature check.
 */
function previewImage(post: RedditPost): string | undefined {
  const preview = post.preview?.images?.[0]?.source?.url;
  if (preview !== undefined && preview !== '') {
    return preview.replace(/&amp;/g, '&');
  }

  const thumbnail = post.thumbnail;
  if (thumbnail === undefined) return undefined;
  // Only a real URL survives; every sentinel fails this.
  return /^https?:\/\//i.test(thumbnail) ? thumbnail : undefined;
}

/**
 * `icon_img` is the classic subreddit icon; `community_icon` is the redesign's.
 * Either can be an empty string, and community_icon arrives with query
 * parameters that make it awkward but still valid.
 */
function pickIcon(iconImg?: string, communityIcon?: string): string | undefined {
  for (const candidate of [iconImg, communityIcon]) {
    if (candidate !== undefined && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

export const redditAdapter = new RedditAdapter();
