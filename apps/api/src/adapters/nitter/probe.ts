/**
 * Instance health probe, for the settings "Test connection" action.
 *
 * Kept out of the adapter: the adapter's job is to return items from the first
 * instance that works, whereas this has to report on every instance, including
 * the ones the adapter would never reach.
 */

import { httpRequest, HttpError } from '../../lib/http.js';
import { FEED_ACCEPT_HEADER } from '../rss/discover.js';
import { FeedParseError, parseFeed } from '../rss/parse.js';
import { buildFeedUrl } from './index.js';

/**
 * A high-volume account, so an empty feed means the instance is broken rather
 * than the account being quiet. Nitter's own project account is the natural
 * choice but is dormant; a large news account is a better signal.
 */
const PROBE_HANDLE = 'nasa';

const PROBE_TIMEOUT_MS = 10_000;

export interface NitterProbeResult {
  baseUrl: string;
  ok: boolean;
  itemCount: number;
  durationMs: number;
  message: string;
}

export async function probeNitterInstance(baseUrl: string): Promise<NitterProbeResult> {
  const startedAt = Date.now();
  const url = buildFeedUrl(baseUrl, PROBE_HANDLE);

  const done = (ok: boolean, itemCount: number, message: string): NitterProbeResult => ({
    baseUrl,
    ok,
    itemCount,
    durationMs: Date.now() - startedAt,
    message,
  });

  try {
    const response = await httpRequest(url, {
      headers: { Accept: FEED_ACCEPT_HEADER },
      timeoutMs: PROBE_TIMEOUT_MS,
      retries: 0,
    });

    if (!response.ok) return done(false, 0, `HTTP ${response.status}`);

    const parsed = await parseFeed(response.body, response.url);

    if (parsed.items.length === 0) {
      // The failure mode this whole adapter has to defend against: a well-formed
      // feed with nothing in it.
      return done(false, 0, 'Returned a well-formed but empty feed');
    }

    return done(true, parsed.items.length, `Returned ${parsed.items.length} items`);
  } catch (err) {
    if (err instanceof FeedParseError) return done(false, 0, 'Response was not a feed');
    if (err instanceof HttpError) return done(false, 0, `${err.kind}: ${err.message}`);
    throw err;
  }
}
