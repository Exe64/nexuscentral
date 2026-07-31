/**
 * Widget data resolvers, one per type.
 *
 * The backend resolves every widget's payload so the browser opens one connection
 * instead of fifteen (decision D7). A resolver may fail; the caller turns that into
 * a per-widget error entry rather than failing the whole response.
 *
 * Adding a widget type means adding a resolver here and a definition in the web
 * registry. Nothing else changes.
 */

import {
  parseWidgetConfig,
  type AlertsWidgetConfig,
  type AlertsWidgetData,
  type CustomApiWidgetConfig,
  type CustomApiWidgetData,
  type FeedWidgetConfig,
  type FeedWidgetData,
  type SourceHealthWidgetConfig,
  type SourceHealthWidgetData,
  type StatsWidgetConfig,
  type StatsWidgetData,
  type Widget,
  type WidgetType,
} from '@nexuscentral/shared';
import { customApiCacheKey, throughCustomApiCache } from '../customapi/cache.js';
import { fetchSpec } from '../customapi/fetch.js';
import { applyMapping } from '../customapi/mapping.js';
import { alertCounts, listAlerts, topSourcesByVolume } from '../db/alerts.js';
import { countItems, itemStats, listItems } from '../db/items.js';
import { listSources, listUnhealthySources, sourceHealthCounts } from '../db/sources.js';
import { getRawSettings, resolveRedditCredentials } from '../db/settings.js';
import { redditBudget } from '../adapters/reddit/budget.js';

export type WidgetResolver = (widget: Widget) => Promise<unknown>;

const resolveFeed: WidgetResolver = async (widget) => {
  const config = parseWidgetConfig('feed', widget.config) as unknown as FeedWidgetConfig;

  const filters = {
    ...(config.tagIds.length > 0 ? { tagIds: config.tagIds } : {}),
    ...(config.sourceIds.length > 0 ? { sourceIds: config.sourceIds } : {}),
    ...(config.unreadOnly ? { unreadOnly: true } : {}),
    ...(config.minScore === null ? {} : { minScore: config.minScore }),
  };

  // The count comes from the same filters, so the widget can say "15 of 240"
  // rather than implying the list is everything.
  const [page, total] = await Promise.all([
    listItems({ ...filters, sort: config.sort, limit: config.limit }),
    countItems(filters),
  ]);

  return { items: page.data, total } satisfies FeedWidgetData;
};

const resolveAlerts: WidgetResolver = async (widget) => {
  const config = parseWidgetConfig('alerts', widget.config) as unknown as AlertsWidgetConfig;

  const [alerts, counts] = await Promise.all([
    listAlerts({
      limit: config.limit,
      ...(config.includeAcknowledged ? {} : { acknowledged: false }),
    }),
    alertCounts(),
  ]);

  return { alerts, unacknowledged: counts.unacknowledged } satisfies AlertsWidgetData;
};

const resolveSourceHealth: WidgetResolver = async (widget) => {
  const config = parseWidgetConfig(
    'source_health',
    widget.config,
  ) as unknown as SourceHealthWidgetConfig;

  const [unhealthy, counts] = await Promise.all([listUnhealthySources(), sourceHealthCounts()]);

  // `showHealthy` is off by default: "All sources healthy." is the useful answer,
  // not a list of forty sources doing their job.
  const sources = config.showHealthy ? await listSources() : unhealthy;

  return {
    sources: sources.slice(0, config.limit),
    unhealthy: unhealthy.length,
    total: counts.total,
  } satisfies SourceHealthWidgetData;
};

const resolveStats: WidgetResolver = async (widget) => {
  const config = parseWidgetConfig('stats', widget.config) as unknown as StatsWidgetConfig;

  const [stats, topSources, settings] = await Promise.all([
    itemStats(),
    topSourcesByVolume(config.topSourceCount),
    getRawSettings(),
  ]);

  const budget = redditBudget.snapshot();

  return {
    itemsToday: stats.today,
    itemsThisWeek: stats.thisWeek,
    unread: stats.unread,
    starred: stats.starred,
    topSources,
    reddit: {
      configured: resolveRedditCredentials(settings) !== null,
      remaining: budget.remaining,
      limit: budget.limit,
      utilisation: budget.utilisation,
      resetIn: budget.resetIn,
    },
  } satisfies StatsWidgetData;
};

/**
 * `custom_api` -- fetch a third-party endpoint and map it.
 *
 * Cached separately from the dashboard-wide widget cache: that one is keyed on
 * the last ingestion, which has nothing to do with when a weather API last
 * changed. This honours the widget's own `ttlMinutes`.
 */
const resolveCustomApi: WidgetResolver = async (widget) => {
  const config = parseWidgetConfig('custom_api', widget.config) as unknown as CustomApiWidgetConfig;

  const spec = { url: config.url, params: config.params, headers: config.headers };

  const outcome = await throughCustomApiCache(
    customApiCacheKey(spec, config.mapping),
    config.ttlMinutes * 60_000,
    async () => {
      const response = await fetchSpec(spec);
      return applyMapping(response.body, config.mapping);
    },
  );

  return {
    items: outcome.items,
    total: outcome.matched,
    render: config.render,
  } satisfies CustomApiWidgetData;
};

export const WIDGET_RESOLVERS: Record<WidgetType, WidgetResolver> = {
  feed: resolveFeed,
  alerts: resolveAlerts,
  source_health: resolveSourceHealth,
  stats: resolveStats,
  custom_api: resolveCustomApi,
};
