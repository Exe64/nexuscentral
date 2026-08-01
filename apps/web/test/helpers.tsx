import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

/** A client that does not retry, so an error path is reached on the first attempt. */
function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

export function renderPage(ui: ReactNode, route = '/'): RenderResult {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

export interface StubRoute {
  status?: number;
  body?: unknown;
  /** Raw text, for endpoints that do not answer JSON (the OPML export). */
  text?: string;
  headers?: Record<string, string>;
}

/**
 * Stub `fetch` with a table keyed by `METHOD /path` (query string included), so a
 * test states exactly which calls it expects the page to make.
 */
export function stubApi(routes: Record<string, StubRoute>): { calls: string[] } {
  const calls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const key = `${method} ${url}`;
      calls.push(key);

      const route = routes[key] ?? routes[`${method} ${url.split('?')[0]}`];
      if (route === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: key } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      const status = route.status ?? 200;
      const body =
        status === 204
          ? null
          : (route.text ?? (route.body === undefined ? '' : JSON.stringify(route.body)));

      return Promise.resolve(
        new Response(body, {
          status,
          headers: route.headers ?? { 'content-type': 'application/json' },
        }),
      );
    }),
  );

  return { calls };
}

export const HEALTH_OK: StubRoute = {
  body: { status: 'ok', version: '0.1.0', uptimeSeconds: 12, db: { reachable: true } },
};

/** Settings as the API returns them, for pages that read a preference. */
export function makeSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    themeMode: 'system',
    themePreset: 'default',
    readerView: 'list',
    accentHue: 250,
    accentChroma: 0.14,
    itemsRetentionDays: 90,
    alertWebhookUrl: null,
    alertWebhookKind: 'none',
    reddit: { configured: false, origin: null, envOverridesSettings: false },
    nitterBaseUrls: [],
    nitterBaseUrlsOrigin: 'env',
    updatedAt: '2026-07-30T09:00:00.000Z',
    ...overrides,
  };
}

export function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1',
    url: 'https://example.com/one',
    title: 'Announcing AOS 7.2',
    summary: 'Erasure coding improvements and a rebuilt Prism UI.',
    author: 'Priya Raman',
    publishedAt: new Date(Date.now() - 3600_000).toISOString(),
    fetchedAt: new Date().toISOString(),
    engagementScore: null,
    engagementComments: null,
    imageUrl: null,
    score: 8.4,
    matchedRules: [],
    readAt: null,
    starred: false,
    source: {
      id: 1,
      title: 'Nutanix Blog',
      kind: 'rss',
      iconUrl: null,
      tags: [
        {
          id: 1,
          name: 'Storage',
          slug: 'storage',
          color: 'teal',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

export function makeSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    kind: 'rss',
    title: 'Nutanix Blog',
    identifier: 'https://www.nutanix.com/blog/rss.xml',
    siteUrl: 'https://www.nutanix.com/blog',
    iconUrl: null,
    weight: 1,
    active: true,
    pollInterval: '15 minutes',
    tags: [],
    health: {
      lastRunAt: new Date().toISOString(),
      lastOkAt: new Date().toISOString(),
      lastError: null,
      consecutiveFailures: 0,
      consecutiveEmpty: 0,
    },
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}
