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

/**
 * Conditional-request state, carried separately from `Source`.
 *
 * `sources.http_etag` and `sources.http_modified` are HTTP plumbing, not domain
 * data: they are never returned by the API and never rendered. Passing them here
 * keeps them off the transport type without hiding them from the one caller that
 * needs them.
 */
export interface ConditionalState {
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export interface FetchContext {
  source: Source;
  /** 30s timeout, enforced by the runner. */
  signal: AbortSignal;
  logger: Logger;
  conditional?: ConditionalState;
}

export interface FetchResult {
  items: NormalizedItem[];
  /** HTTP 304 -- `items` must then be empty. */
  notModified?: boolean;
  etag?: string;
  lastModified?: string;
  /**
   * Set when zero items is the normal steady state for this run rather than a
   * symptom.
   *
   * A cursor-based adapter asking "anything since X?" gets an empty answer most
   * of the time, and counting that towards silent-death detection would flag
   * every quiet subreddit. Nitter is the opposite case: it fails by returning a
   * well-formed empty feed, which is exactly what that counter exists to catch.
   */
  emptyIsExpected?: boolean;
  /** Opaque cursor state to persist for the next run, when the adapter uses one. */
  cursor?: string;
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
