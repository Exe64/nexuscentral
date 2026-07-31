/**
 * Widget config schemas.
 *
 * Shared rather than duplicated: the API rejects an invalid config at the boundary
 * (01-SPEC-data-model.md 1.7) and the config forms produce one, and two copies of
 * the same rules would drift the first time a field changed.
 *
 * Adding a widget type means adding a schema and a default here, then one entry in
 * each registry -- server-side for the data resolver, client-side for the form and
 * the body.
 */

import { z } from 'zod';
import { ITEM_SORTS, WIDGET_TYPES, type WidgetType } from './domain.js';

const tagIds = z.array(z.number().int().positive()).max(50);
const sourceIds = z.array(z.number().int().positive()).max(200);

/**
 * `collapseAfter` renders N items and hides the rest behind "Show more". Borrowed
 * from Glance, and the single best idea in its design: it stops one chatty source
 * from burying every other widget on the page.
 */
const collapseAfter = z.number().int().min(1).max(50).nullable();

export const feedWidgetConfigSchema = z.object({
  /** Empty means every source. */
  tagIds: tagIds.default([]),
  sourceIds: sourceIds.default([]),
  sort: z.enum(ITEM_SORTS).default('published'),
  unreadOnly: z.boolean().default(false),
  minScore: z.number().nullable().default(null),
  limit: z.number().int().min(1).max(50).default(15),
  showThumbnails: z.boolean().default(false),
  showSource: z.boolean().default(true),
  collapseAfter: collapseAfter.default(null),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
});

export const alertsWidgetConfigSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  /** Acknowledged alerts are history; the widget is for what still needs a look. */
  includeAcknowledged: z.boolean().default(false),
});

export const sourceHealthWidgetConfigSchema = z.object({
  /** Off by default: "All sources healthy." is the useful state, not a list. */
  showHealthy: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10),
});

export const statsWidgetConfigSchema = z.object({
  showRedditBudget: z.boolean().default(true),
  topSourceCount: z.number().int().min(1).max(20).default(5),
});

export const customApiWidgetConfigSchema = z.object({
  /**
   * Empty is a valid *default*, not a valid *save*.
   *
   * `defaultWidgetConfig` parses `{}` to seed the config form, so a required URL
   * here would make the form -- and `GET /api/widget-types` -- throw. The widget
   * routes reject an empty URL on create and update instead.
   */
  url: z.string().max(2000).default(''),
  params: z.record(z.string()).default({}),
  headers: z.record(z.string()).default({}),
  mapping: z
    .object({ root: z.string(), fields: z.record(z.string()) })
    .default({ root: '$', fields: {} }),
  render: z.enum(['list', 'list_with_meta', 'single_value', 'key_values']).default('list'),
  ttlMinutes: z.number().int().min(1).max(1440).default(30),
  collapseAfter: collapseAfter.default(null),
});

export const WIDGET_CONFIG_SCHEMAS = {
  feed: feedWidgetConfigSchema,
  alerts: alertsWidgetConfigSchema,
  source_health: sourceHealthWidgetConfigSchema,
  stats: statsWidgetConfigSchema,
  custom_api: customApiWidgetConfigSchema,
} as const satisfies Record<WidgetType, z.ZodTypeAny>;

export type FeedWidgetConfig = z.infer<typeof feedWidgetConfigSchema>;
export type AlertsWidgetConfig = z.infer<typeof alertsWidgetConfigSchema>;
export type SourceHealthWidgetConfig = z.infer<typeof sourceHealthWidgetConfigSchema>;
export type StatsWidgetConfig = z.infer<typeof statsWidgetConfigSchema>;
export type CustomApiWidgetConfig = z.infer<typeof customApiWidgetConfigSchema>;

/** Parse a config for a type, filling in defaults. Throws a ZodError on a bad one. */
export function parseWidgetConfig(type: WidgetType, config: unknown): Record<string, unknown> {
  return WIDGET_CONFIG_SCHEMAS[type].parse(config ?? {}) as Record<string, unknown>;
}

/** The default config for a type: what a freshly added widget starts with. */
export function defaultWidgetConfig(type: WidgetType): Record<string, unknown> {
  return parseWidgetConfig(type, {});
}

/**
 * Grid geometry per type (04-SPEC-frontend.md 3, 4).
 *
 * `minSize` is enforced by the grid so a widget cannot be shrunk into
 * unreadability -- a feed at two rows high shows half a headline.
 */
export interface WidgetGeometry {
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
}

export const WIDGET_GEOMETRY: Record<WidgetType, WidgetGeometry> = {
  feed: { defaultSize: { w: 4, h: 8 }, minSize: { w: 3, h: 4 } },
  alerts: { defaultSize: { w: 4, h: 6 }, minSize: { w: 3, h: 3 } },
  source_health: { defaultSize: { w: 4, h: 6 }, minSize: { w: 3, h: 3 } },
  stats: { defaultSize: { w: 4, h: 5 }, minSize: { w: 3, h: 3 } },
  custom_api: { defaultSize: { w: 4, h: 6 }, minSize: { w: 3, h: 3 } },
};

/** Every type is available; `custom_api` landed in Phase 6. */
export const AVAILABLE_WIDGET_TYPES: readonly WidgetType[] = WIDGET_TYPES;
