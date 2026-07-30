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
  Item,
  ItemSort,
  Settings,
  Source,
  SourceKind,
  Tag,
  TagColor,
  TagWithCounts,
} from '@feedhub/shared';
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
  settings: ['settings'] as const,
  health: ['health'] as const,
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

// --- settings --------------------------------------------------------------

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () => (await apiFetch<Envelope<Settings>>('/settings')).data,
  });
}

export interface SettingsPatchBody {
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
