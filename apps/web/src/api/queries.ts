/**
 * Typed server state. One module so every query key is visible in one place and
 * a mutation cannot forget what it needs to invalidate.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  Breakpoint,
  Dashboard,
  DashboardData,
  DashboardWithWidgets,
  Item,
  ItemDetail,
  ItemSort,
  Rule,
  RuleScope,
  RuleTestResult,
  Settings,
  Source,
  SourceKind,
  Tag,
  TagColor,
  TagWithCounts,
  ThemeMode,
  ThemePreset,
  Widget,
  WidgetType,
} from '@nexuscentral/shared';
import { apiFetch } from './client.ts';

/** Most endpoints answer `{ data }`; the item list adds a cursor. */
interface Envelope<T> {
  data: T;
}

interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}

export const keys = {
  tags: ['tags'] as const,
  sources: (filters?: SourceListFilters) =>
    filters === undefined ? (['sources'] as const) : (['sources', filters] as const),
  source: (id: number) => ['sources', id] as const,
  items: (filters: ItemListFilters) => ['items', filters] as const,
  item: (id: string) => ['items', 'detail', id] as const,
  rules: ['rules'] as const,
  ruleTest: (input: RuleTestInput) => ['rules', 'test', input] as const,
  dashboards: ['dashboards'] as const,
  dashboard: (id: number) => ['dashboards', id] as const,
  dashboardData: (id: number) => ['dashboards', id, 'data'] as const,
  settings: ['settings'] as const,
  health: ['health'] as const,
  session: ['auth', 'session'] as const,
  sessions: ['auth', 'sessions'] as const,
};

// --- tags ------------------------------------------------------------------

export function useTags(): UseQueryResult<TagWithCounts[]> {
  return useQuery({
    queryKey: keys.tags,
    queryFn: async () => (await apiFetch<Envelope<TagWithCounts[]>>('/tags')).data,
  });
}

export function useCreateTag(): UseMutationResult<Tag, Error, { name: string; color: TagColor }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (await apiFetch<Envelope<Tag>>('/tags', { method: 'POST', body })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.tags });
    },
  });
}

export function useUpdateTag(): UseMutationResult<
  Tag,
  Error,
  { id: number; name?: string; color?: TagColor }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) =>
      (await apiFetch<Envelope<Tag>>(`/tags/${id}`, { method: 'PATCH', body })).data,
    onSuccess: () => {
      // A rename changes what every source row displays.
      void client.invalidateQueries({ queryKey: keys.tags });
      void client.invalidateQueries({ queryKey: ['sources'] });
      void client.invalidateQueries({ queryKey: ['items'] });
    },
  });
}

export interface TagDeletionSummary {
  affectedWidgets: number;
  affectedRules: number;
  affectedSources: number;
}

export function useDeleteTag(): UseMutationResult<TagDeletionSummary, Error, number> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id) =>
      (await apiFetch<Envelope<TagDeletionSummary>>(`/tags/${id}`, { method: 'DELETE' })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.tags });
      void client.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

// --- sources ---------------------------------------------------------------

export interface SourceListFilters {
  kind?: SourceKind;
  tag?: number;
  active?: boolean;
  q?: string;
}

function toSearchParams(filters: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function useSources(filters: SourceListFilters = {}): UseQueryResult<Source[]> {
  return useQuery({
    queryKey: keys.sources(filters),
    queryFn: async () =>
      (await apiFetch<Envelope<Source[]>>(`/sources${toSearchParams(filters)}`)).data,
  });
}

export interface ResolveCandidate {
  kind: SourceKind;
  identifier: string;
  title: string;
  siteUrl?: string;
  iconUrl?: string;
  sampleItems: { title: string; url: string; publishedAt: string; summary?: string }[];
  existingSourceId: number | null;
}

export function useResolveSource(): UseMutationResult<ResolveCandidate[], Error, string> {
  return useMutation({
    mutationFn: async (input) =>
      (
        await apiFetch<{ candidates: ResolveCandidate[] }>('/sources/resolve', {
          method: 'POST',
          body: { input },
        })
      ).candidates,
  });
}

export interface CreateSourceBody {
  kind: SourceKind;
  identifier: string;
  title: string;
  siteUrl?: string | null;
  iconUrl?: string | null;
  tagIds?: number[];
  weight?: number;
  pollInterval?: string;
}

export function useCreateSource(): UseMutationResult<Source, Error, CreateSourceBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (await apiFetch<Envelope<Source>>('/sources', { method: 'POST', body })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sources'] });
      void client.invalidateQueries({ queryKey: keys.tags });
    },
  });
}

export function useUpdateSource(): UseMutationResult<
  Source,
  Error,
  { id: number } & Partial<CreateSourceBody> & { active?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) =>
      (await apiFetch<Envelope<Source>>(`/sources/${id}`, { method: 'PATCH', body })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sources'] });
      void client.invalidateQueries({ queryKey: keys.tags });
    },
  });
}

export function useDeleteSource(): UseMutationResult<void, Error, number> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      await apiFetch<void>(`/sources/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      // Deleting a source removes its items, so the reader is stale too.
      void client.invalidateQueries({ queryKey: ['sources'] });
      void client.invalidateQueries({ queryKey: ['items'] });
      void client.invalidateQueries({ queryKey: keys.tags });
    },
  });
}

export function usePollSource(): UseMutationResult<{ queued: boolean }, Error, number> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id) =>
      (await apiFetch<Envelope<{ queued: boolean }>>(`/sources/${id}/poll`, { method: 'POST' }))
        .data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

export interface ImportSummary {
  created: number;
  alreadyTracked: number;
  failed: { xmlUrl: string; reason: string }[];
  skippedOutlines: number;
}

export function useImportOpml(): UseMutationResult<
  ImportSummary,
  Error,
  { opml: string; tagIds?: number[]; importCategoriesAsTags?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (await apiFetch<Envelope<ImportSummary>>('/sources/import', { method: 'POST', body })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sources'] });
      void client.invalidateQueries({ queryKey: keys.tags });
    },
  });
}

// --- items -----------------------------------------------------------------

export interface ItemListFilters {
  tagIds?: number[];
  sourceIds?: number[];
  unreadOnly?: boolean;
  starredOnly?: boolean;
  minScore?: number;
  q?: string;
  sort?: ItemSort;
  limit?: number;
}

export function useItems(
  filters: ItemListFilters = {},
): UseInfiniteQueryResult<{ pages: CursorPage<Item>[] }, Error> {
  return useInfiniteQuery({
    queryKey: keys.items(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiFetch<CursorPage<Item>>(
        `/items${toSearchParams({ ...filters, cursor: pageParam ?? undefined })}`,
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * Read and star toggles.
 *
 * The item list is invalidated rather than patched in place: an unread-only view
 * has to drop the row, and reconciling that by hand across every cached page is
 * how a list ends up disagreeing with the server.
 */
export function useSetItemRead(): UseMutationResult<void, Error, { id: string; read: boolean }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, read }) => {
      await apiFetch<void>(`/items/${id}/read`, { method: read ? 'POST' : 'DELETE' });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['items'] });
      void client.invalidateQueries({ queryKey: keys.tags });
    },
  });
}

export function useSetItemStarred(): UseMutationResult<
  void,
  Error,
  { id: string; starred: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, starred }) => {
      await apiFetch<void>(`/items/${id}/star`, { method: starred ? 'POST' : 'DELETE' });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['items'] });
    },
  });
}

export function useMarkAllRead(): UseMutationResult<{ updated: number }, Error, ItemListFilters> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (filters) =>
      (
        await apiFetch<Envelope<{ updated: number }>>('/items/read-all', {
          method: 'POST',
          body: filters,
        })
      ).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['items'] });
      void client.invalidateQueries({ queryKey: keys.tags });
    },
  });
}

// --- rules -----------------------------------------------------------------

export function useRules(): UseQueryResult<Rule[]> {
  return useQuery({
    queryKey: keys.rules,
    queryFn: async () => (await apiFetch<Envelope<Rule[]>>('/rules')).data,
  });
}

export interface RuleBody {
  name: string;
  pattern: string;
  flags?: string;
  scope?: RuleScope;
  weight?: number;
  alert?: boolean;
  active?: boolean;
  tagFilter?: number[];
}

/**
 * Creating, updating or deleting a rule enqueues a debounced rescore, so the
 * scores the reader shows are about to change.
 */
function invalidateAfterRuleChange(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: keys.rules });
  void client.invalidateQueries({ queryKey: ['items'] });
}

export function useCreateRule(): UseMutationResult<Rule, Error, RuleBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (await apiFetch<Envelope<Rule>>('/rules', { method: 'POST', body })).data,
    onSuccess: () => invalidateAfterRuleChange(client),
  });
}

export function useUpdateRule(): UseMutationResult<
  Rule,
  Error,
  { id: number } & Partial<RuleBody>
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) =>
      (await apiFetch<Envelope<Rule>>(`/rules/${id}`, { method: 'PATCH', body })).data,
    onSuccess: () => invalidateAfterRuleChange(client),
  });
}

export function useDeleteRule(): UseMutationResult<void, Error, number> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      await apiFetch<void>(`/rules/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => invalidateAfterRuleChange(client),
  });
}

export interface RuleTestInput {
  pattern: string;
  flags: string;
  scope: RuleScope;
  tagFilter: number[];
}

/**
 * The live test panel.
 *
 * A query rather than a mutation: it is a read, it should be cached per input, and
 * `enabled` lets the caller hold it back until the pattern is worth sending.
 */
export function useRuleTest(
  input: RuleTestInput,
  enabled: boolean,
): UseQueryResult<RuleTestResult> {
  return useQuery({
    queryKey: keys.ruleTest(input),
    enabled,
    // An invalid pattern is a legitimate answer, not a failure to retry.
    retry: false,
    staleTime: 10_000,
    queryFn: () => apiFetch<RuleTestResult>('/rules/test', { method: 'POST', body: input }),
  });
}

// --- item detail -----------------------------------------------------------

export interface ItemDetailResponse extends ItemDetail {
  /** The score recomputed now, which drifts from the stored one as time passes. */
  liveScore: number;
}

/** Backs the score-breakdown popover: how a rule set gets debugged. */
export function useItemDetail(id: string | null): UseQueryResult<ItemDetailResponse> {
  return useQuery({
    queryKey: keys.item(id ?? ''),
    enabled: id !== null,
    queryFn: async () => (await apiFetch<Envelope<ItemDetailResponse>>(`/items/${id ?? ''}`)).data,
  });
}

// --- dashboards and widgets ------------------------------------------------

export function useDashboards(): UseQueryResult<Dashboard[]> {
  return useQuery({
    queryKey: keys.dashboards,
    queryFn: async () => (await apiFetch<Envelope<Dashboard[]>>('/dashboards')).data,
  });
}

/** The structure: dashboard plus its widgets, with no widget data. */
export function useDashboard(id: number | null): UseQueryResult<DashboardWithWidgets> {
  return useQuery({
    queryKey: keys.dashboard(id ?? 0),
    enabled: id !== null,
    queryFn: async () =>
      (await apiFetch<Envelope<DashboardWithWidgets>>(`/dashboards/${id ?? 0}`)).data,
  });
}

/**
 * Every widget's payload, in one request.
 *
 * Decision D7: fifteen widgets fetching independently would mean fifteen
 * connections on load and rate limiting reimplemented in the browser.
 */
export function useDashboardData(id: number | null): UseQueryResult<DashboardData> {
  return useQuery({
    queryKey: keys.dashboardData(id ?? 0),
    enabled: id !== null,
    // The server caches each payload for 60s; asking more often just burns a round
    // trip.
    staleTime: 30_000,
    queryFn: () => apiFetch<DashboardData>(`/dashboards/${id ?? 0}/data`),
  });
}

export function useCreateDashboard(): UseMutationResult<Dashboard, Error, { name: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (await apiFetch<Envelope<Dashboard>>('/dashboards', { method: 'POST', body })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.dashboards });
    },
  });
}

export function useUpdateDashboard(): UseMutationResult<
  Dashboard,
  Error,
  { id: number; name?: string; position?: number }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) =>
      (await apiFetch<Envelope<Dashboard>>(`/dashboards/${id}`, { method: 'PATCH', body })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['dashboards'] });
    },
  });
}

export function useDeleteDashboard(): UseMutationResult<void, Error, number> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      await apiFetch<void>(`/dashboards/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['dashboards'] });
    },
  });
}

export interface LayoutEntry {
  widgetId: number;
  breakpoint: Breakpoint;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bulk layout persistence.
 *
 * No cache invalidation on success, on purpose: the grid already shows the new
 * positions, and refetching would replace them with an identical set while the
 * user is still dragging.
 */
export function useSaveLayout(): UseMutationResult<
  { updated: number },
  Error,
  { dashboardId: number; layouts: LayoutEntry[] }
> {
  return useMutation({
    mutationFn: async ({ dashboardId, layouts }) =>
      (
        await apiFetch<Envelope<{ updated: number }>>(`/dashboards/${dashboardId}/layout`, {
          method: 'PATCH',
          body: { layouts },
        })
      ).data,
  });
}

export interface CreateWidgetBody {
  dashboardId: number;
  type: WidgetType;
  title: string;
  config?: Record<string, unknown>;
}

function invalidateDashboard(client: ReturnType<typeof useQueryClient>, dashboardId: number): void {
  void client.invalidateQueries({ queryKey: keys.dashboard(dashboardId) });
  void client.invalidateQueries({ queryKey: keys.dashboardData(dashboardId) });
}

export function useCreateWidget(): UseMutationResult<Widget, Error, CreateWidgetBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (await apiFetch<Envelope<Widget>>('/widgets', { method: 'POST', body })).data,
    onSuccess: (widget) => invalidateDashboard(client, widget.dashboardId),
  });
}

export function useUpdateWidget(): UseMutationResult<
  Widget,
  Error,
  { id: number; title?: string; config?: Record<string, unknown> }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) =>
      (await apiFetch<Envelope<Widget>>(`/widgets/${id}`, { method: 'PATCH', body })).data,
    onSuccess: (widget) => invalidateDashboard(client, widget.dashboardId),
  });
}

export function useDeleteWidget(): UseMutationResult<void, Error, Widget> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (widget) => {
      await apiFetch<void>(`/widgets/${widget.id}`, { method: 'DELETE' });
    },
    onSuccess: (_result, widget) => invalidateDashboard(client, widget.dashboardId),
  });
}

/** Refresh one widget without reloading the other fourteen. */
export function useRefreshWidget(): UseMutationResult<
  DashboardData,
  Error,
  { widgetId: number; dashboardId: number }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ widgetId }) =>
      apiFetch<DashboardData>(`/widgets/${widgetId}/data`, { method: 'POST' }),
    onSuccess: (result, { dashboardId }) => {
      // Merge into the batched payload rather than refetching all of it.
      client.setQueryData<DashboardData>(keys.dashboardData(dashboardId), (current) =>
        current === undefined
          ? result
          : { ...current, widgets: { ...current.widgets, ...result.widgets } },
      );
    },
  });
}

// --- alerts ----------------------------------------------------------------

export function useAcknowledgeAlert(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      await apiFetch<void>(`/alerts/${id}/ack`, { method: 'POST' });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['dashboards'] });
    },
  });
}

// --- settings --------------------------------------------------------------

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () => (await apiFetch<Envelope<Settings>>('/settings')).data,
  });
}

export interface SettingsPatchBody {
  themeMode?: ThemeMode;
  themePreset?: ThemePreset;
  accentHue?: number;
  accentChroma?: number;
  redditClientId?: string | null;
  redditClientSecret?: string | null;
  nitterBaseUrls?: string[];
  itemsRetentionDays?: number;
}

export function useUpdateSettings(): UseMutationResult<Settings, Error, SettingsPatchBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (await apiFetch<Envelope<Settings>>('/settings', { method: 'PATCH', body })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.settings });
      // Configuring Reddit or Nitter changes whether a source can be polled.
      void client.invalidateQueries({ queryKey: ['sources'] });
      void client.invalidateQueries({ queryKey: keys.health });
    },
  });
}

export interface RedditTestResult {
  ok: boolean;
  reason?: 'not_configured' | 'rejected' | 'upstream';
  message?: string;
  origin?: 'env' | 'settings';
  budget?: { remaining: number | null; resetIn: number | null; utilisation: number | null };
}

export function useTestReddit(): UseMutationResult<RedditTestResult, Error, void> {
  return useMutation({
    mutationFn: async () =>
      (await apiFetch<Envelope<RedditTestResult>>('/settings/test-reddit', { method: 'POST' }))
        .data,
  });
}

export interface NitterInstanceResult {
  baseUrl: string;
  ok: boolean;
  itemCount: number;
  durationMs: number;
  message: string;
}

export interface NitterTestResult {
  ok: boolean;
  reason?: 'not_configured';
  message?: string;
  instances: NitterInstanceResult[];
}

export function useTestNitter(): UseMutationResult<NitterTestResult, Error, void> {
  return useMutation({
    mutationFn: async () =>
      (await apiFetch<Envelope<NitterTestResult>>('/settings/test-nitter', { method: 'POST' }))
        .data,
  });
}

// --- health ----------------------------------------------------------------

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptimeSeconds: number;
  db: { reachable: boolean };
}

export function useHealth(): UseQueryResult<HealthResponse> {
  return useQuery({ queryKey: keys.health, queryFn: () => apiFetch<HealthResponse>('/health') });
}

// --- auth ------------------------------------------------------------------

export interface SessionState {
  authenticated: boolean;
  /** False only if the credential row was removed from under a running instance. */
  configured: boolean;
}

/**
 * The query the whole shell waits on.
 *
 * No retry: a 401 here is the answer, not a failure to get one, and retrying it
 * three times just delays the login screen.
 */
export function useSession(): UseQueryResult<SessionState> {
  return useQuery({
    queryKey: keys.session,
    queryFn: async () => (await apiFetch<Envelope<SessionState>>('/auth/session')).data,
    retry: false,
    staleTime: 30_000,
  });
}

export function useLogin(): UseMutationResult<void, Error, { password: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      await apiFetch<void>('/auth/login', { method: 'POST', body });
    },
    onSuccess: () => {
      // Write the fact we just learned straight into the cache. The gate is
      // watching this query, so it flips on this line.
      //
      // Deliberately NOT `client.clear()` first: clearing removes the query
      // object the mounted observer holds, and the observer does not re-bind to
      // the replacement. The gate would keep rendering the login screen after a
      // successful sign-in -- which is exactly what it did.
      client.setQueryData<SessionState>(keys.session, { authenticated: true, configured: true });

      // Anything cached before the session ended may have failed with a 401.
      // Everything except the auth queries refetches on next use.
      void client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    },
  });
}

export function useLogout(): UseMutationResult<void, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiFetch<void>('/auth/logout', { method: 'POST' });
    },
    onSuccess: () => {
      // Flip the gate first: that unmounts everything protected, so the removal
      // below is not fighting live observers.
      client.setQueryData<SessionState>(keys.session, { authenticated: false, configured: true });

      // Drop rather than invalidate: refetching protected queries while signed
      // out would just produce a burst of 401s, and nothing should survive to be
      // shown to whoever signs in next.
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    },
  });
}

export function useChangePassword(): UseMutationResult<
  { revokedSessions: number },
  Error,
  { currentPassword: string; newPassword: string }
> {
  return useMutation({
    mutationFn: async (body) =>
      (
        await apiFetch<Envelope<{ revokedSessions: number }>>('/auth/password', {
          method: 'POST',
          body,
        })
      ).data,
  });
}

export interface SessionRecord {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  current?: boolean;
}

export function useSessions(): UseQueryResult<SessionRecord[]> {
  return useQuery({
    queryKey: keys.sessions,
    queryFn: async () => (await apiFetch<Envelope<SessionRecord[]>>('/auth/sessions')).data,
  });
}

export function useRevokeOtherSessions(): UseMutationResult<
  { revokedSessions: number },
  Error,
  void
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (
        await apiFetch<Envelope<{ revokedSessions: number }>>('/auth/sessions/revoke-others', {
          method: 'POST',
        })
      ).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.sessions });
    },
  });
}
