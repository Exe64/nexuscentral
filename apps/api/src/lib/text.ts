/**
 * Turning feed HTML into the plain-text `summary` column.
 *
 * Full-text article extraction and reader-mode rewriting are non-goals
 * (00-CONTEXT.md 4). This does the minimum: strip markup, decode entities,
 * collapse whitespace, truncate on a word boundary.
 */

export const SUMMARY_MAX_LENGTH = 1000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  deg: '°',
  euro: '€',
  pound: '£',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      // Reject non-characters and out-of-range code points rather than throwing.
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripHtml(input: string): string {
  return (
    input
      // Script and style bodies are not prose; drop them wholesale before tags.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Block-level boundaries carry meaning: without a space, "<p>a</p><p>b</p>"
      // would become "ab".
      .replace(/<\/?(p|div|br|li|tr|h[1-6]|blockquote|section|article)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
  );
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate to `maxLength`, preferring the last word boundary. Appends an
 * ellipsis, which is included in the budget so the result never exceeds it.
 */
export function truncateOnWord(input: string, maxLength = SUMMARY_MAX_LENGTH): string {
  if (input.length <= maxLength) return input;

  const budget = maxLength - 1; // room for the ellipsis
  const slice = input.slice(0, budget);
  const lastSpace = slice.lastIndexOf(' ');

  // Only honour the word boundary if it is not absurdly early -- a single
  // 2000-character "word" should still be truncated rather than emptied.
  const cut = lastSpace > budget * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** The full pipeline: HTML in, a `summary` column value out. */
export function toSummary(
  html: string | null | undefined,
  maxLength = SUMMARY_MAX_LENGTH,
): string | undefined {
  if (html === null || html === undefined) return undefined;
  const text = truncateOnWord(collapseWhitespace(decodeEntities(stripHtml(html))), maxLength);
  return text.length > 0 ? text : undefined;
}

/** Titles get the same treatment minus the truncation budget. */
export function toPlainTitle(input: string): string {
  return collapseWhitespace(decodeEntities(stripHtml(input)));
}
