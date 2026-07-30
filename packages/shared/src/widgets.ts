/**
 * Widget config shapes (see 04-SPEC-frontend.md 4).
 *
 * The zod schemas that validate these live next to each widget definition in
 * apps/web; the API imports them to reject an invalid config at the boundary
 * rather than discovering it at render time.
 */

import type { ItemSort } from './domain.js';

export type Density = 'comfortable' | 'compact';

export interface FeedWidgetConfig {
  /** Empty means all sources. */
  tagIds: number[];
  sourceIds: number[];
  sort: ItemSort;
  unreadOnly: boolean;
  minScore: number | null;
  /** 1..50 */
  limit: number;
  showThumbnails: boolean;
  showSource: boolean;
  /**
   * Render N items and hide the rest behind "Show more". Stops one chatty
   * source from burying every other widget on the page.
   */
  collapseAfter: number | null;
  density: Density;
}

export type CustomApiRender = 'list' | 'list_with_meta' | 'single_value' | 'key_values';

export interface FetchSpecMapping {
  /** JSONPath selecting the array of elements. */
  root: string;
  /** JSONPath per output field, relative to an element. */
  fields: Record<string, string>;
}

export interface FetchSpec {
  url: string;
  params: Record<string, string>;
  /** `${VAR}` placeholders resolve from server-side environment variables. */
  headers: Record<string, string>;
  mapping: FetchSpecMapping;
}

export interface CustomApiWidgetConfig extends FetchSpec {
  render: CustomApiRender;
  ttlMinutes: number;
  collapseAfter: number | null;
}

export interface AlertsWidgetConfig {
  limit: number;
}

export interface SourceHealthWidgetConfig {
  /** Records nothing today; kept so the type exists and configs stay uniform. */
  showHealthy: boolean;
}

export interface StatsWidgetConfig {
  showRedditBudget: boolean;
}

/** The generic item shape every custom_api renderer consumes. */
export interface GenericItem {
  title: string;
  url?: string;
  subtitle?: string;
  timestamp?: string;
  value?: string | number;
}
