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
  type FeedWidgetConfig,
  type FeedWidgetData,
  type SourceHealthWidgetConfig,
  type SourceHealthWidgetData,
  type StatsWidgetConfig,
  type StatsWidgetData,
  type Widget,
  type WidgetType,
} from '@nexuscentral/shared';
import { alertCounts, listAlerts, topSourcesByVolume } from '../db/alerts.js';
import { countItems, itemStats, listItems } from '../db/items.js';
import { listSources, listUnhealthySources, sourceHealthCounts } from '../db/sources.js';
import { getRawSettings, resolveRedditCredentials } from '../db/settings.js';
import { redditBudget } from '../adapters/reddit/budget.js';
import { HttpError } from '../http/errors.js';

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

const resolveCustomApi: WidgetResolver = () => {
  // Phase 6. Reported as a widget-level error so the rest of the dashboard renders.
  return Promise.reject(
    HttpError.validation('custom_api widgets are not supported by this build yet.'),
  );
};

export const WIDGET_RESOLVERS: Record<WidgetType, WidgetResolver> = {
  feed: resolveFeed,
  alerts: resolveAlerts,
  source_health: resolveSourceHealth,
  stats: resolveStats,
  custom_api: resolveCustomApi,
};
