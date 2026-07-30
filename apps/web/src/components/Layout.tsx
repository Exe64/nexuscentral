/**
 * Phase 1 shell: navigation and a health line.
 *
 * The real shell -- persistent sidebar, top bar, tag list with unread counts,
 * keyboard shortcuts -- arrives in Phase 4 alongside the theme tokens. This
 * stays deliberately plain so there is nothing to unwind then.
 */

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useHealth } from '../api/queries.ts';
import { ApiRequestError } from '../api/client.ts';
import { useT } from '../i18n.tsx';

function HealthLine(): ReactNode {
  const t = useT();
  const { data, error, isPending, refetch, isFetching } = useHealth();

  if (isPending) return <span>{t('health.checking')}</span>;

  if (error) {
    const message =
      error instanceof ApiRequestError && error.code === 'NETWORK'
        ? t('health.unreachable')
        : t('health.error');
    return (
      <span>
        {message}{' '}
        <button type="button" onClick={() => void refetch()} disabled={isFetching}>
          {t('health.retry')}
        </button>
      </span>
    );
  }

  return <span>{t('health.ok', { version: data.version })}</span>;
}

export function Layout({ children }: { children: ReactNode }): ReactNode {
  const t = useT();

  return (
    <div>
      <header>
        <h1>{t('app.name')}</h1>
        <nav>
          <ul>
            <li>
              <NavLink to="/reader">{t('nav.reader')}</NavLink>
            </li>
            <li>
              <NavLink to="/sources">{t('nav.sources')}</NavLink>
            </li>
            <li>
              <NavLink to="/tags">{t('nav.tags')}</NavLink>
            </li>
            <li>
              <NavLink to="/settings">{t('nav.settings')}</NavLink>
            </li>
          </ul>
        </nav>
      </header>

      <main>{children}</main>

      <footer>
        <HealthLine />
      </footer>
    </div>
  );
}
