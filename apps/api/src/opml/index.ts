/**
 * OPML import and export.
 *
 * OPML outlines are attribute-only elements, so a small tokeniser is enough and
 * an XML parser dependency is not justified -- the same reasoning that keeps an
 * i18n library out of the frontend. Nesting still matters: most readers export
 * folders as enclosing outlines, and those folders are exactly the user's tags.
 */

import { decodeEntities } from '../lib/text.js';

export interface OpmlFeed {
  title: string;
  xmlUrl: string;
  htmlUrl?: string;
  /** Enclosing folder names plus anything in a `category` attribute. */
  categories: string[];
}

export interface OpmlDocument {
  title?: string;
  feeds: OpmlFeed[];
  /** Outlines that looked like feeds but carried no usable xmlUrl. */
  skipped: number;
}

interface Token {
  attributes: Record<string, string>;
  selfClosing: boolean;
}

const OUTLINE_OPEN = /<outline\b([^>]*?)(\/?)>/gi;
const OUTLINE_CLOSE = /<\/outline\s*>/gi;
const ATTRIBUTE = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function readAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    if (name !== undefined) attributes[name] = decodeEntities(value);
  }
  return attributes;
}

/**
 * Walk the document in order, tracking the folder stack so each feed outline
 * knows which folders enclose it.
 */
export function parseOpml(xml: string): OpmlDocument {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(xml)?.[1]?.trim();

  // One pass over both open and close tags, ordered by position, so nesting
  // depth is tracked without building a full DOM.
  const events: { index: number; kind: 'open' | 'close'; token?: Token }[] = [];

  OUTLINE_OPEN.lastIndex = 0;
  for (const match of xml.matchAll(OUTLINE_OPEN)) {
    events.push({
      index: match.index,
      kind: 'open',
      token: {
        attributes: readAttributes(match[1] ?? ''),
        selfClosing: match[2] === '/',
      },
    });
  }
  OUTLINE_CLOSE.lastIndex = 0;
  for (const match of xml.matchAll(OUTLINE_CLOSE)) {
    events.push({ index: match.index, kind: 'close' });
  }
  events.sort((a, b) => a.index - b.index);

  const folders: string[] = [];
  const feeds: OpmlFeed[] = [];
  let skipped = 0;

  for (const event of events) {
    if (event.kind === 'close') {
      folders.pop();
      continue;
    }

    const token = event.token as Token;
    const attributes = token.attributes;
    const xmlUrl = attributes['xmlurl']?.trim();
    const label = (attributes['text'] ?? attributes['title'] ?? '').trim();

    if (xmlUrl !== undefined && xmlUrl !== '') {
      const explicit = (attributes['category'] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');

      const htmlUrl = attributes['htmlurl']?.trim();

      feeds.push({
        title: label !== '' ? label : xmlUrl,
        xmlUrl,
        ...(htmlUrl === undefined || htmlUrl === '' ? {} : { htmlUrl }),
        categories: [...new Set([...folders, ...explicit])],
      });

      // A feed outline with children is unusual but legal; keep the stack honest.
      if (!token.selfClosing) folders.push(label);
      continue;
    }

    // No xmlUrl. A container outline is a folder; a leaf without one is a feed
    // entry we cannot use.
    if (token.selfClosing) {
      if (attributes['type']?.toLowerCase() === 'rss') skipped += 1;
    } else {
      folders.push(label);
    }
  }

  return { ...(title === undefined || title === '' ? {} : { title }), feeds, skipped };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface OpmlExportSource {
  title: string;
  /** The feed URL. */
  xmlUrl: string;
  htmlUrl?: string | null;
  categories: string[];
}

/**
 * Build an OPML 2.0 document.
 *
 * Flat outlines with a `category` attribute rather than nested folders: a source
 * can carry several tags, and a folder hierarchy can only express one. The
 * importer above reads both forms, so this still round-trips.
 */
export function buildOpml(sources: readonly OpmlExportSource[], title = 'feedhub'): string {
  const outlines = sources
    .map((source) => {
      const attributes = [
        `type="rss"`,
        `text="${escapeAttribute(source.title)}"`,
        `title="${escapeAttribute(source.title)}"`,
        `xmlUrl="${escapeAttribute(source.xmlUrl)}"`,
      ];
      if (source.htmlUrl !== null && source.htmlUrl !== undefined && source.htmlUrl !== '') {
        attributes.push(`htmlUrl="${escapeAttribute(source.htmlUrl)}"`);
      }
      if (source.categories.length > 0) {
        attributes.push(`category="${escapeAttribute(source.categories.join(','))}"`);
      }
      return `      <outline ${attributes.join(' ')} />`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeAttribute(title)}</title>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}
