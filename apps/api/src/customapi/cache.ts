/**
 * Response cache for `custom_api` widgets.
 *
 * Separate from the dashboard widget cache on purpose. That one is keyed on the
 * last ingestion timestamp, which is the right signal for a feed and a meaningless
 * one for a third-party endpoint: polling a weather API every time an RSS item
 * arrives would be rude and slow. This one honours the widget's own TTL.
 *
 * Keyed on the fetch spec rather than the widget id, so two widgets pointed at
 * the same endpoint share one request -- and a config change is a different key
 * rather than something to remember to invalidate.
 */

import { createHash } from 'node:crypto';

/** Enough for far more custom widgets than a single user will have. */
const MAX_ENTRIES = 100;

interface Entry {
  value: unknown;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

export function customApiCacheKey(spec: unknown, mapping: unknown): string {
  return createHash('sha256').update(JSON.stringify({ spec, mapping })).digest('hex');
}

export async function throughCustomApiCache<T>(
  key: string,
  ttlMs: number,
  resolve: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const existing = entries.get(key);
  if (existing !== undefined && existing.expiresAt > now) return existing.value as T;

  // A rejection is never cached: a rate limit or a blip must not stick for the
  // widget's whole TTL, which for a custom API can be a day.
  const value = await resolve();

  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  entries.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

export function clearCustomApiCache(): void {
  entries.clear();
}

export function customApiCacheSize(): number {
  return entries.size;
}
