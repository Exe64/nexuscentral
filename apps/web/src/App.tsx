/**
 * Phase 0 shell: prove the browser can reach the API through the proxy.
 *
 * The routes, sidebar and grid from 04-SPEC-frontend.md arrive in Phases 1, 4
 * and 5. This deliberately stays a single screen so there is nothing to unwind.
 */

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiRequestError } from './api/client.ts';
import { I18nProvider, useT } from './i18n.tsx';

interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptimeSeconds: number;
  db: { reachable: boolean };
}

function HealthCheck(): ReactNode {
  const t = useT();
  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/health'),
  });

  if (isPending) return <p>{t('health.checking')}</p>;

  if (error) {
    // A network-level failure and a reachable-but-unhealthy API are different
    // problems with different fixes, so they get different copy.
    const message =
      error instanceof ApiRequestError && error.code === 'NETWORK'
        ? t('health.unreachable')
        : t('health.error');
    return (
      <div>
        <p>{message}</p>
        <button type="button" onClick={() => void refetch()} disabled={isFetching}>
          {t('health.retry')}
        </button>
      </div>
    );
  }

  return <p>{t('health.ok', { version: data.version })}</p>;
}

function Shell(): ReactNode {
  const t = useT();
  return (
    <main>
      <h1>{t('app.name')}</h1>
      <p>{t('app.tagline')}</p>
      <HealthCheck />
    </main>
  );
}

export function App(): ReactNode {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}
