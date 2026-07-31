/**
 * Widget-adjacent types that are not derived from a config schema.
 *
 * The config shapes themselves live in `widget-config.ts`, inferred from the zod
 * schemas so there is exactly one definition of each.
 */

export type Density = 'comfortable' | 'compact';

export const CUSTOM_API_RENDERS = ['list', 'list_with_meta', 'single_value', 'key_values'] as const;
export type CustomApiRender = (typeof CUSTOM_API_RENDERS)[number];

export interface CustomApiWidgetData {
  items: GenericItem[];
  /** Root elements matched before the cap, so the widget can say what it hid. */
  total: number;
  /** Echoed back so the body renders without re-reading the config. */
  render: CustomApiRender;
}

/** The generic item shape every `custom_api` renderer will consume in Phase 6. */
export interface GenericItem {
  title: string;
  url?: string;
  subtitle?: string;
  timestamp?: string;
  value?: string | number;
}

// --- what the batched data endpoint returns, per widget type ---------------

import type { Alert, Item, Source } from './domain.js';

export interface FeedWidgetData {
  items: Item[];
  /** Total matching the filter, so the widget can say "15 of 240". */
  total: number;
}

export interface AlertsWidgetData {
  alerts: Alert[];
  unacknowledged: number;
}

export interface SourceHealthWidgetData {
  sources: Source[];
  /** Zero here is a feature: "All sources healthy." is worth saying. */
  unhealthy: number;
  total: number;
}

export interface StatsWidgetData {
  itemsToday: number;
  itemsThisWeek: number;
  unread: number;
  starred: number;
  topSources: { id: number; title: string; count: number }[];
  reddit: {
    configured: boolean;
    remaining: number | null;
    limit: number | null;
    utilisation: number | null;
    resetIn: number | null;
  };
}
