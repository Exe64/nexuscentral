/**
 * The og:image fallback, for items whose feed carried no preview.
 *
 * Measured coverage is why this exists: the feed alone gets Ars Technica to
 * 20/20 and The Verge to 10/10, but leaves the GitHub blog at 3/10 and Reddit at
 * 8/25. Those gaps are articles that do have an `og:image`; they simply do not
 * put it in the feed.
 *
 * Two things make this safe enough to run unattended against arbitrary URLs the
 * feeds hand us:
 *
 * - **Every hop goes through the SSRF guard**, and the connection is pinned to
 *   the address that was checked. This fetches whatever a third party put in a
 *   feed, so it is a request-forging primitive in exactly the way the custom_api
 *   fetch is, and it gets the same treatment.
 * - **It stops reading at `</head>`.** The tag is in the head, and articles run
 *   to megabytes. Reading the whole body would multiply the cost of a backfill by
 *   a hundred for nothing.
 */

import { Agent, request as undiciRequest } from 'undici';
import { usableUrl } from '../adapters/rss/image.js';
import { BlockedTargetError, resolveTarget } from '../customapi/ssrf.js';
import { logger } from '../logger.js';
import { USER_AGENT } from '../version.js';

const log = logger.child({ component: 'og-image' });

/**
 * Hard ceiling on what is read before giving up on finding a head.
 *
 * A page whose `<head>` has not closed within this is either minified into one
 * enormous line or not really a document; either way the tag is not worth more
 * bandwidth.
 */
export const HEAD_MAX_BYTES = 256 * 1024;

export const TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;

/** Ordered by how reliably each one names the article's own picture. */
const META_PATTERNS = [
  /<meta[^>]+property\s*=\s*["']og:image(?::url)?["'][^>]*>/i,
  /<meta[^>]+name\s*=\s*["']og:image["'][^>]*>/i,
  /<meta[^>]+name\s*=\s*["']twitter:image(?::src)?["'][^>]*>/i,
  /<link[^>]+rel\s*=\s*["']image_src["'][^>]*>/i,
];

const CONTENT_ATTR = /\b(?:content|href)\s*=\s*["']([^"']+)["']/i;

/**
 * The article's own preview image, or null when it has none.
 *
 * Never throws for an ordinary failure: a 404, a timeout, a blocked address and
 * a page with no tag are all "no image", and the caller records the attempt so
 * it is not repeated. Only a programming error escapes.
 */
export async function fetchOgImage(articleUrl: string): Promise<string | null> {
  try {
    return await scrape(articleUrl);
  } catch (err) {
    if (err instanceof BlockedTargetError) {
      // Worth a line: a feed pointing at a private address is either a
      // misconfiguration or someone probing the network from the outside.
      log.warn({ url: articleUrl, reason: err.message }, 'Refused to fetch a blocked target');
      return null;
    }
    log.debug(
      { url: articleUrl, error: err instanceof Error ? err.message : String(err) },
      'No og:image',
    );
    return null;
  }
}

async function scrape(articleUrl: string): Promise<string | null> {
  let target = await resolveTarget(articleUrl);
  let redirects = 0;

  for (;;) {
    const agent = new Agent({
      connect: {
        // Pinned to the address the guard checked, so DNS cannot change its
        // answer between the check and the connection.
        lookup: (_hostname, _options, callback) => {
          callback(null, [{ address: target.address, family: target.family }]);
        },
      },
    });

    try {
      const response = await undiciRequest(target.url, {
        method: 'GET',
        headers: {
          host: target.url.host,
          accept: 'text/html,application/xhtml+xml',
          // No cookies, no referer: this is a robot reading a public page.
          'user-agent': USER_AGENT,
        },
        dispatcher: agent,
        headersTimeout: TIMEOUT_MS,
        bodyTimeout: TIMEOUT_MS,
      });

      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && typeof location === 'string') {
        // `dump()`, not `destroy()`: destroying an undici body raises an
        // AbortError that lands nowhere and takes the process down with it.
        await response.body.dump();

        redirects += 1;
        if (redirects > MAX_REDIRECTS) return null;
        target = await resolveTarget(new URL(location, target.url).toString());
        continue;
      }

      if (response.statusCode >= 400) {
        await response.body.dump();
        return null;
      }

      const contentType = response.headers['content-type'];
      if (typeof contentType === 'string' && !/html|xml/i.test(contentType)) {
        await response.body.dump();
        return null;
      }

      const head = await readHead(response.body);
      // The final URL, so a relative og:image resolves against where the
      // document actually came from rather than where we started.
      return findImage(head, target.url.toString());
    } finally {
      await agent.close();
    }
  }
}

/**
 * Read only as far as the closing `</head>`.
 *
 * Returns whatever was read if the tag never arrives, because plenty of real
 * pages omit it and their meta tags are still in the first chunk.
 */
async function readHead(body: AsyncIterable<Buffer>): Promise<string> {
  // Streaming decode, so a multi-byte character split across two chunks is not
  // turned into replacement characters inside a URL we are about to store.
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;

  for await (const chunk of body) {
    bytes += chunk.length;
    text += decoder.decode(chunk, { stream: true });

    // Searched on the accumulated text, not the chunk: the tag straddles a
    // boundary often enough that per-chunk matching would miss it.
    const headEnd = text.search(/<\/head\s*>/i);
    if (headEnd !== -1) return text.slice(0, headEnd);
    if (bytes >= HEAD_MAX_BYTES) return text;
  }

  return text + decoder.decode();
}

function findImage(head: string, baseUrl: string): string | null {
  for (const pattern of META_PATTERNS) {
    const tag = pattern.exec(head)?.[0];
    if (tag === undefined) continue;

    const raw = CONTENT_ATTR.exec(tag)?.[1];
    // The same rules the feed extractor applies: absolute, http(s), not a pixel.
    const url = usableUrl(raw === undefined ? undefined : decodeEntities(raw), baseUrl);
    if (url !== undefined) return url;
  }
  return null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&');
}
