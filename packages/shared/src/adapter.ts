/**
 * The source adapter contract (see 02-SPEC-ingestion.md 2).
 *
 * Every adapter must be unit-testable against recorded fixtures with no network
 * access. Fixtures live in /apps/api/test/fixtures/<kind>/.
 */

import type { Source, SourceKind } from './domain.js';

export interface NormalizedItem {
  url: string;
  title: string;
  summary?: string;
  author?: string;
  publishedAt: Date;
  engagementScore?: number;
  engagementComments?: number;
  /** Adapter-supplied stable id, preferred over the URL for deduplication. */
  guid?: string;
  raw: unknown;
}

/** Minimal structural logger, so adapters never depend on a concrete pino type. */
export interface Logger {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface FetchContext {
  source: Source;
  /** 30s timeout, enforced by the runner. */
  signal: AbortSignal;
  logger: Logger;
}

export interface FetchResult {
  items: NormalizedItem[];
  /** HTTP 304 -- `items` must then be empty. */
  notModified?: boolean;
  etag?: string;
  lastModified?: string;
}

/** A candidate returned by `resolve`, ready to become a source. */
export interface ResolvedSource {
  kind: SourceKind;
  identifier: string;
  title: string;
  siteUrl?: string;
  iconUrl?: string;
  /** Up to 3 real items. Seeing them before committing is what makes adding a source safe. */
  sampleItems: NormalizedItem[];
}

export interface SourceAdapter {
  kind: SourceKind;
  fetch(ctx: FetchContext): Promise<FetchResult>;
  /** Validate and enrich a user-entered identifier before the source is created. */
  resolve(input: string): Promise<ResolvedSource[]>;
}
