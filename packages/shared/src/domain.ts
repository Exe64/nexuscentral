/**
 * Domain types mirroring the PostgreSQL schema (see 01-SPEC-data-model.md).
 *
 * These are the *transport* shapes: camelCase, dates as ISO 8601 strings, so a
 * value can travel from a `pg` row through the API to the browser unchanged.
 * Database row shapes stay inside apps/api.
 */

export const SOURCE_KINDS = ['rss', 'reddit', 'nitter'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const TAG_COLORS = [
  'neutral',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const RULE_SCOPES = ['title', 'summary', 'both', 'author'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export const WIDGET_TYPES = ['feed', 'custom_api', 'alerts', 'source_health', 'stats'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const WEBHOOK_KINDS = ['none', 'ntfy', 'gotify', 'discord', 'generic'] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export const ITEM_SORTS = ['score', 'published', 'engagement'] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];

export const BREAKPOINTS = ['lg', 'md', 'sm', 'xs'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

export interface Tag {
  id: number;
  name: string;
  slug: string;
  color: TagColor;
  createdAt: string;
}

/** Tag with the aggregate counts returned by `GET /api/tags`. */
export interface TagWithCounts extends Tag {
  sourceCount: number;
  unreadCount: number;
}

export interface Source {
  id: number;
  kind: SourceKind;
  title: string;
  /**
   * Canonical identifier, per kind:
   *   rss    -> absolute feed URL
   *   reddit -> subreddit name, lowercase, no `r/` prefix
   *   nitter -> X handle, lowercase, no `@` prefix
   */
  identifier: string;
  siteUrl: string | null;
  iconUrl: string | null;
  /** Multiplies the item base score. 1.00 is neutral. */
  weight: number;
  active: boolean;
  /** PostgreSQL interval, rendered as text (e.g. `15 minutes`). */
  pollInterval: string;
  tags: Tag[];
  health: SourceHealth;
  createdAt: string;
}

export interface SourceHealth {
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  consecutiveEmpty: number;
}

/** The source fields denormalised onto every item so a row renders in one trip. */
export interface ItemSource {
  id: number;
  title: string;
  kind: SourceKind;
  iconUrl: string | null;
  tags: Tag[];
}

export interface Item {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  author: string | null;
  publishedAt: string;
  fetchedAt: string;
  engagementScore: number | null;
  engagementComments: number | null;
  score: number;
  matchedRules: number[];
  readAt: string | null;
  starred: boolean;
  source: ItemSource;
}

/** `GET /api/items/:id` adds the score breakdown. See 02-SPEC-ingestion.md 5.4. */
export interface ItemDetail extends Item {
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  base: number;
  rules: { id: number; name: string; weight: number }[];
  engagement: number;
  sourceWeight: number;
  recencyDecay: number;
}

export interface Rule {
  id: number;
  name: string;
  /** JS-flavoured regex source, no delimiters. */
  pattern: string;
  flags: string;
  scope: RuleScope;
  /** May be negative -- that is how noise is demoted. */
  weight: number;
  alert: boolean;
  active: boolean;
  /** When non-empty, restricts the rule to sources carrying one of these tags. */
  tagFilter: number[];
  createdAt: string;
}

export interface Alert {
  id: string;
  item: Item;
  rule: Pick<Rule, 'id' | 'name'>;
  createdAt: string;
  deliveredAt: string | null;
  deliveryError: string | null;
  acknowledgedAt: string | null;
}

export interface GridPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type WidgetLayout = Partial<Record<Breakpoint, GridPosition>>;

export interface Widget {
  id: number;
  dashboardId: number;
  type: WidgetType;
  title: string;
  config: Record<string, unknown>;
  layout: WidgetLayout;
  createdAt: string;
}

export interface Dashboard {
  id: number;
  name: string;
  position: number;
  createdAt: string;
}

export interface DashboardWithWidgets extends Dashboard {
  widgets: Widget[];
}

/**
 * Settings as returned by the API. Secret columns are never included -- each is
 * replaced by a boolean `configured` flag.
 */
export interface Settings {
  themeMode: ThemeMode;
  accentHue: number;
  accentChroma: number;
  itemsRetentionDays: number;
  alertWebhookUrl: string | null;
  alertWebhookKind: WebhookKind;
  redditConfigured: boolean;
  nitterBaseUrls: string[];
  updatedAt: string;
}

export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface Health {
  status: HealthStatus;
  sources: { total: number; active: number; failing: number; stale: number };
  reddit: { configured: boolean; remaining: number | null; resetIn: number | null };
  queue: { pending: number; failed: number };
  lastPollAt: string | null;
}
