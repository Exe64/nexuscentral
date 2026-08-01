/**
 * The preview image for a feed item, found without leaving the feed.
 *
 * Measured across real feeds before this was written, because the right shape
 * depends entirely on what publishers actually emit:
 *
 *   Ars Technica   20/20 items   `media:content` and `media:thumbnail`
 *   The Verge      10/10 items   nothing but the first `<img>` in the body
 *   Reddit new.rss  8/25 items   `media:thumbnail`, link posts only
 *   GitHub blog     3/10 items   first `<img>` in the body
 *   Hacker News     0/30 items   no body at all
 *
 * So no single channel is enough, and the HTML fallback is not optional: it is
 * the only thing that covers The Verge. What the feed cannot supply is left to
 * the og:image job, which is why this returns undefined rather than guessing.
 */

/** Below this, an image is furniture or a tracking pixel, not a preview. */
const MIN_DIMENSION = 64;

/**
 * Hosts that serve analytics pixels dressed as images. Matched as a suffix on
 * the hostname, so a subdomain cannot slip past.
 */
const PIXEL_HOSTS = [
  'feedburner.com',
  'feeds.feedburner.com',
  'pixel.wp.com',
  'stats.wordpress.com',
  'doubleclick.net',
  'scorecardresearch.com',
  'googletagmanager.com',
];

/** `<img>` in feed HTML, with whatever attribute order the generator felt like. */
const IMG_TAG = /<img\b[^>]*>/gi;
const ATTR = (name: string): RegExp => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');

/** The `$` bag xml2js puts XML attributes in. */
interface MediaNode {
  $?: { url?: string; medium?: string; type?: string; width?: string; height?: string };
}

export interface ImageCandidateSource {
  'media:thumbnail'?: unknown;
  'media:content'?: unknown;
  enclosure?: { url?: string; type?: string } | undefined;
  itunes?: { image?: string } | undefined;
  'content:encoded'?: string | undefined;
  content?: string | undefined;
  summary?: string | undefined;
}

/**
 * Pick a preview image, or undefined when the feed carries none.
 *
 * `base` resolves relative sources, which Atom permits and several generators
 * emit for images even when their links are absolute.
 */
export function extractImageUrl(item: ImageCandidateSource, base?: string): string | undefined {
  for (const node of mediaNodes(item['media:thumbnail'])) {
    const url = fromMediaNode(node, base);
    if (url !== undefined) return url;
  }

  for (const node of mediaNodes(item['media:content'])) {
    // `medium` and `type` are advisory and often absent; only reject on a
    // positive statement that this is not an image, never on silence.
    const medium = node.$?.medium;
    const type = node.$?.type;
    if (medium !== undefined && medium !== 'image') continue;
    if (type !== undefined && !type.startsWith('image/')) continue;

    const url = fromMediaNode(node, base);
    if (url !== undefined) return url;
  }

  const enclosure = item.enclosure;
  if (enclosure?.url !== undefined && enclosure.type?.startsWith('image/') === true) {
    const url = usableUrl(enclosure.url, base);
    if (url !== undefined) return url;
  }

  const itunes = usableUrl(item.itunes?.image, base);
  if (itunes !== undefined) return itunes;

  return fromHtml(item['content:encoded'] ?? item.content ?? item.summary, base);
}

/** A media element may be one node or several; xml2js gives whichever it saw. */
function mediaNodes(raw: unknown): MediaNode[] {
  if (Array.isArray(raw)) return raw.filter(isMediaNode);
  return isMediaNode(raw) ? [raw] : [];
}

function isMediaNode(value: unknown): value is MediaNode {
  return typeof value === 'object' && value !== null;
}

function fromMediaNode(node: MediaNode, base: string | undefined): string | undefined {
  if (tooSmall(node.$?.width, node.$?.height)) return undefined;
  return usableUrl(node.$?.url, base);
}

/**
 * The first `<img>` big enough to be a preview.
 *
 * Not simply the first `<img>`: publishers open the body with a tracking pixel
 * often enough that taking it on faith would give a feed of 1x1 thumbnails.
 */
function fromHtml(html: string | undefined, base: string | undefined): string | undefined {
  if (html === undefined || html === '') return undefined;

  IMG_TAG.lastIndex = 0;
  for (const [tag] of html.matchAll(IMG_TAG)) {
    if (tooSmall(attr(tag, 'width'), attr(tag, 'height'))) continue;

    // `data-src` first: lazy-loading markup leaves a placeholder in `src`.
    const raw = attr(tag, 'data-src') ?? attr(tag, 'src');
    const url = usableUrl(raw === undefined ? undefined : decodeEntities(raw), base);
    if (url !== undefined) return url;
  }
  return undefined;
}

function attr(tag: string, name: string): string | undefined {
  return ATTR(name).exec(tag)?.[1];
}

function tooSmall(width: string | undefined, height: string | undefined): boolean {
  for (const raw of [width, height]) {
    if (raw === undefined) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0 && value < MIN_DIMENSION) return true;
  }
  return false;
}

/**
 * Absolute, http(s), and not a known pixel.
 *
 * `data:` is refused rather than inlined: a base64 image in a feed is unbounded
 * and would go straight into a text column read on every render.
 *
 * Exported because the og:image job has to apply exactly these rules to what it
 * scrapes; two copies of this would drift and one of them would be the lenient one.
 */
export function usableUrl(raw: string | undefined, base: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  let url: URL;
  try {
    url = base === undefined ? new URL(trimmed) : new URL(trimmed, base);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  const host = url.hostname.toLowerCase();
  if (PIXEL_HOSTS.some((pixel) => host === pixel || host.endsWith(`.${pixel}`))) return undefined;

  return url.toString();
}

/** Only the entities that actually appear in feed attribute values. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
