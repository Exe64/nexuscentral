/**
 * Per-widget payload cache (03-SPEC-api.md 6).
 *
 * Keyed by `hash(widget.id, widget.config, lastItemInsertedAt)` with a 60 second
 * TTL. Including the ingestion timestamp means a poll that inserts something
 * invalidates every widget at once, which is what the user expects: new items
 * should appear, not wait out a TTL.
 *
 * In memory, not in PostgreSQL. Single user, single process; a table would add a
 * write per read for no benefit.
 */

import { createHash } from 'node:crypto';
import type { Widget } from '@nexuscentral/shared';

export const CACHE_TTL_MS = 60_000;

/** Enough for far more widgets than a single user will have. */
const MAX_ENTRIES = 200;

interface Entry {
  key: string;
  value: unknown;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

export function widgetCacheKey(widget: Widget, lastInsertedAt: string): string {
  return createHash('sha256')
    .update(`${widget.id}|${JSON.stringify(widget.config)}|${lastInsertedAt}`)
    .digest('hex');
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
}

let hits = 0;
let misses = 0;

/**
 * Resolve through the cache.
 *
 * A rejected resolver is never cached: a transient database error must not stick
 * around for a minute pretending to be an answer.
 */
export async function throughCache<T>(
  key: string,
  resolve: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const existing = entries.get(key);
  if (existing !== undefined && existing.expiresAt > now) {
    hits += 1;
    return existing.value as T;
  }

  misses += 1;
  const value = await resolve();

  // Cheapest possible eviction: the map is insertion-ordered, so the first key is
  // the oldest. Nothing here justifies an LRU.
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  entries.set(key, { key, value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Drop a widget's entries, e.g. after its config changed. */
export function invalidateWidget(widgetId: number): void {
  // The key is a hash, so the widget id is not recoverable from it. Clearing
  // everything is correct and costs one round of recomputation for a handful of
  // widgets -- an edit is rare and a stale widget is worse.
  void widgetId;
  entries.clear();
}

export function clearWidgetCache(): void {
  entries.clear();
  hits = 0;
  misses = 0;
}

export function widgetCacheStats(): CacheStats {
  return { size: entries.size, hits, misses };
}
