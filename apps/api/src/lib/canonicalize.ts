/**
 * URL canonicalisation for deduplication (02-SPEC-ingestion.md 4).
 *
 * The same article arriving twice from one feed with different tracking
 * parameters must hash to the same value, or every newsletter link becomes a
 * fresh item on every poll.
 */

/**
 * Parameters that identify the *referrer*, not the content. `s` and `si` are
 * Twitter's and YouTube's share tokens; `ref` and `ref_src` are used by both.
 */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref', 'ref_src', 's', 'si']);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

/**
 * Returns a canonical form of `url`, or the trimmed input unchanged when it does
 * not parse. An unparseable URL still needs a stable hash input -- returning it
 * verbatim keeps dedup working for that item instead of throwing during a poll.
 */
export function canonicalize(url: string): string {
  const trimmed = url.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  // `URL` already lowercases the protocol and host.
  parsed.hash = '';

  if (parsed.hostname.startsWith('www.')) {
    parsed.hostname = parsed.hostname.slice(4);
  }

  const kept: [string, string][] = [];
  for (const [name, value] of parsed.searchParams) {
    if (!isTrackingParam(name)) kept.push([name, value]);
  }

  // Sort so that ?b=2&a=1 and ?a=1&b=2 are the same URL. Compare on the value
  // too, so repeated keys (?tag=a&tag=b) order deterministically.
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const search = new URLSearchParams(kept);
  const query = search.toString();
  parsed.search = query.length > 0 ? `?${query}` : '';

  // Strip a trailing slash on a non-empty path: `/posts/hello/` and
  // `/posts/hello` are one page. The root path `/` is left alone.
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}
