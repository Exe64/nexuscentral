/**
 * Mapping a JSON response onto the generic item shape (03-SPEC-api.md 7).
 *
 * `root` selects the array; `fields` map each element. Both are JSONPath, which
 * is what the Glance widgets being ported already express their accessors in, so
 * porting is a transcription rather than a translation (04-SPEC-frontend.md 7).
 */

import { JSONPath } from 'jsonpath-plus';
import type { GenericItem } from '@nexuscentral/shared';

export interface Mapping {
  root: string;
  fields: Record<string, string>;
}

/** How many items one widget may render. A 5 MB response can hold a lot. */
export const MAX_ITEMS = 200;

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

/** jsonpath-plus types `json` as a concrete union; anything decoded is fine. */
type JsonValue = Parameters<typeof JSONPath>[0] extends { json: infer J } ? J : never;

/**
 * Evaluate a path.
 *
 * jsonpath-plus is lenient to the point of never complaining: `$[` returns the
 * root, `nonsense((` returns nothing, and neither throws. So this catch is a
 * safety net for a future version, **not** the validation step -- a wrong path is
 * caught by the preview endpoint showing that it selected nothing, which is the
 * only feedback the library makes possible.
 */
function evaluate(path: string, json: unknown): unknown[] {
  try {
    return JSONPath({ path, json: json as JsonValue, wrap: true }) as unknown as unknown[];
  } catch (err) {
    throw new MappingError(
      `"${path}" could not be evaluated: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Anything printable becomes a string; anything else becomes nothing.
 *
 * Returning `[object Object]` for a field that pointed at the wrong node would
 * render as a plausible-looking value, which is worse than an empty one.
 */
function scalar(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

/**
 * A timestamp the frontend can format.
 *
 * Accepts ISO strings and Unix seconds or milliseconds, because APIs use all
 * three and the widget author should not have to care which.
 */
function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number') {
    // Seconds until roughly the year 2286, then milliseconds.
    const ms = value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  const text = scalar(value);
  if (text === undefined) return undefined;

  if (/^\d+$/.test(text)) return timestamp(Number(text));

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Select the array of elements the mapping applies to. */
export function selectRoot(json: unknown, root: string): unknown[] {
  const path = root.trim() === '' ? '$' : root;

  // `$` on an array means the array itself, not a one-element wrapper round it.
  if (path === '$') return Array.isArray(json) ? json : [json];

  const matched = evaluate(path, json);
  if (matched.length === 0) return [];

  // A path selecting one node that happens to be an array means "these items".
  if (matched.length === 1 && Array.isArray(matched[0])) return matched[0];
  return matched;
}

/**
 * Map one element. `title` is the only required field: an item with no title has
 * nothing to render, so it is dropped rather than shown as a blank row.
 */
function mapElement(element: unknown, fields: Record<string, string>): GenericItem | null {
  const pick = (path: string | undefined): unknown => {
    if (path === undefined || path.trim() === '') return undefined;
    const matched = evaluate(path, element);
    return matched.length === 0 ? undefined : matched[0];
  };

  const title = scalar(pick(fields.title));
  if (title === undefined || title.trim() === '') return null;

  const item: GenericItem = { title: title.slice(0, 400) };

  const url = scalar(pick(fields.url));
  // Only http(s): a mapped `javascript:` URL would be rendered as a link.
  if (url !== undefined && /^https?:\/\//i.test(url)) item.url = url;

  const subtitle = scalar(pick(fields.subtitle));
  if (subtitle !== undefined) item.subtitle = subtitle.slice(0, 400);

  const when = timestamp(pick(fields.timestamp));
  if (when !== undefined) item.timestamp = when;

  const value = pick(fields.value);
  const asScalar = scalar(value);
  if (asScalar !== undefined) item.value = typeof value === 'number' ? value : asScalar;

  return item;
}

export interface MappedResult {
  items: GenericItem[];
  /** How many root elements were found before the cap and the title filter. */
  matched: number;
  /** Elements dropped for having no title, so the preview can say so. */
  dropped: number;
}

export function applyMapping(json: unknown, mapping: Mapping): MappedResult {
  const elements = selectRoot(json, mapping.root);
  const capped = elements.slice(0, MAX_ITEMS);

  const items: GenericItem[] = [];
  for (const element of capped) {
    const item = mapElement(element, mapping.fields);
    if (item !== null) items.push(item);
  }

  return { items, matched: elements.length, dropped: capped.length - items.length };
}

export const __testing = { scalar, timestamp };
