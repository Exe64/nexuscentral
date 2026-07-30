/**
 * Feed discovery: turn whatever the user pasted into candidate feed URLs.
 *
 * `POST /api/sources/resolve` is the single most important endpoint for
 * usability (03-SPEC-api.md 2) -- one free-text input, the server figures out
 * the rest. That means accepting a blog homepage, not just a feed URL.
 */

const XML_CONTENT_TYPES = [
  'application/rss+xml',
  'application/atom+xml',
  'application/xml',
  'text/xml',
  'application/rdf+xml',
];

export const FEED_ACCEPT_HEADER =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';

/** Relative paths tried when a page advertises no feed at all. */
const FALLBACK_PATHS = ['/feed', '/rss', '/index.xml', '/atom.xml'];

export function isXmlContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return XML_CONTENT_TYPES.includes(mime);
}

/**
 * Some servers serve feeds as `text/plain` or `text/html`. Sniffing the first
 * element is cheap and rescues those cases; without it, a correct feed behind a
 * misconfigured server looks like a page with no feed.
 */
export function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 1000).toLowerCase();
  return /<(rss|feed|rdf:rdf)\b/.test(head);
}

interface HtmlTagAttributes {
  [name: string]: string;
}

/**
 * Pull the attributes out of every occurrence of `<tagName ...>`.
 *
 * A real HTML parser would be more correct, but discovery only needs `<link>`
 * attributes from a document `<head>`, and adding a DOM dependency to read two
 * attributes is not a trade worth making.
 */
function extractTags(html: string, tagName: string): HtmlTagAttributes[] {
  const tagPattern = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  const attrPattern = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

  const found: HtmlTagAttributes[] = [];
  for (const tagMatch of html.matchAll(tagPattern)) {
    const attributes: HtmlTagAttributes = {};
    for (const attrMatch of (tagMatch[1] ?? '').matchAll(attrPattern)) {
      const name = attrMatch[1]?.toLowerCase();
      const value = attrMatch[3] ?? attrMatch[4] ?? attrMatch[5] ?? '';
      if (name !== undefined) attributes[name] = value;
    }
    found.push(attributes);
  }
  return found;
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (href === undefined || href.trim() === '') return undefined;
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return undefined;
  }
}

/**
 * `<link rel="alternate" type="application/rss+xml">` links from an HTML
 * document, in document order -- generators list the main feed first, and the
 * UI shows candidates in the order returned.
 */
export function extractFeedLinks(html: string, baseUrl: string): string[] {
  const urls: string[] = [];

  for (const attrs of extractTags(html, 'link')) {
    const rel = attrs['rel']?.toLowerCase() ?? '';
    const type = attrs['type']?.toLowerCase() ?? '';
    if (!rel.split(/\s+/).includes('alternate')) continue;
    if (!XML_CONTENT_TYPES.includes(type)) continue;

    const href = absolute(attrs['href'], baseUrl);
    if (href !== undefined && !urls.includes(href)) urls.push(href);
  }

  return urls;
}

/** The site icon, from `<link rel="icon">` and friends, falling back to /favicon.ico. */
export function extractIconUrl(html: string, baseUrl: string): string | undefined {
  const candidates: { rel: string; href: string }[] = [];

  for (const attrs of extractTags(html, 'link')) {
    const rel = attrs['rel']?.toLowerCase() ?? '';
    const rels = rel.split(/\s+/);
    if (!rels.includes('icon') && !rels.includes('apple-touch-icon')) continue;

    const href = absolute(attrs['href'], baseUrl);
    if (href !== undefined) candidates.push({ rel, href });
  }

  // Prefer a plain `icon`; apple-touch-icon is a large PNG meant for home
  // screens and is a heavier download for a 16px slot in a list row.
  const plain = candidates.find((c) => c.rel.split(/\s+/).includes('icon'));
  const chosen = plain ?? candidates[0];
  if (chosen !== undefined) return chosen.href;

  return absolute('/favicon.ico', baseUrl);
}

/** The last-resort guesses, relative to the origin of `url`. */
export function fallbackFeedUrls(url: string): string[] {
  try {
    const { origin } = new URL(url);
    return FALLBACK_PATHS.map((path) => `${origin}${path}`);
  } catch {
    return [];
  }
}

/** The document `<title>`, used when a discovered feed has no title of its own. */
export function extractHtmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}
