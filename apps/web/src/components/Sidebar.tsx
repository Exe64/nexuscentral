/**
 * The persistent left sidebar (04-SPEC-frontend.md 2).
 *
 * Navigation, dashboards, and the tag list with unread counts. On `lg+` it is
 * always there; on smaller screens it slides over and closes when a link is
 * followed, because a nav panel that stays open after navigating hides the thing
 * you navigated to.
 */

import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useDashboards, useHealth, useLogout, useTags } from '../api/queries.ts';
import { useT, type Translate } from '../i18n.tsx';
import { useUiStore } from '../stores/ui.ts';
import { formatNumber } from '../lib/format.ts';
import { TagChip } from './TagChip.tsx';

const NAV: { to: string; labelKey: string }[] = [
  { to: '/reader', labelKey: 'nav.reader' },
  { to: '/sources', labelKey: 'nav.sources' },
  { to: '/tags', labelKey: 'nav.tags' },
  { to: '/rules', labelKey: 'nav.rules' },
  { to: '/settings', labelKey: 'nav.settings' },
];

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'block rounded px-2 py-1.5 text-sm',
    isActive ? 'bg-accent-subtle text-primary font-medium' : 'text-secondary hover:bg-hovered',
  ].join(' ');
}

/**
 * Dashboards, listed rather than hidden behind a picker: with a handful of them,
 * seeing the names is the whole navigation.
 */
function DashboardList({ t }: { t: Translate }): ReactNode {
  const dashboards = useDashboards();
  const closeSidebar = useUiStore((state) => state.closeSidebar);

  if (dashboards.data === undefined || dashboards.data.length === 0) return null;

  return (
    <div className="mt-6">
      <h2 className="text-muted px-2 text-xs font-semibold tracking-wide uppercase">
        {t('nav.dashboardsSection')}
      </h2>
      <ul className="mt-2 space-y-0.5">
        {dashboards.data.map((dashboard) => (
          <li key={dashboard.id}>
            <NavLink to={`/d/${dashboard.id}`} className={navClass} onClick={closeSidebar}>
              {dashboard.name}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TagList({ t }: { t: Translate }): ReactNode {
  const tags = useTags();
  const closeSidebar = useUiStore((state) => state.closeSidebar);
  const navigate = useNavigate();

  if (tags.data === undefined || tags.data.length === 0) return null;

  return (
    <div className="mt-6">
      <h2 className="text-muted px-2 text-xs font-semibold tracking-wide uppercase">
        {t('nav.tagsSection')}
      </h2>
      <ul className="mt-2 space-y-0.5">
        {tags.data.map((tag) => (
          <li key={tag.id}>
            <button
              type="button"
              className="hover:bg-hovered flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left"
              onClick={() => {
                // Filtering the reader by tag is the point of the tag list.
                navigate(`/reader?tag=${tag.id}`);
                closeSidebar();
              }}
            >
              <TagChip tag={tag} />
              <span
                className={`tabular-nums text-xs ${tag.unreadCount > 0 ? 'text-primary' : 'text-muted'}`}
              >
                {formatNumber(tag.unreadCount)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HealthLine({ t }: { t: Translate }): ReactNode {
  const health = useHealth();

  if (health.error !== null) {
    return (
      <p className="text-negative px-2 text-xs" role="status">
        {t('health.unreachable')}
      </p>
    );
  }
  if (health.data === undefined) return null;

  const degraded = health.data.status !== 'ok';
  return (
    <p className={`px-2 text-xs ${degraded ? 'text-warning' : 'text-muted'}`} role="status">
      {degraded ? t('health.degraded') : t('health.ok', { version: health.data.version })}
    </p>
  );
}

function SignOut({ t }: { t: Translate }): ReactNode {
  const logout = useLogout();

  return (
    <button
      type="button"
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
      className="text-secondary hover:bg-hovered w-full rounded px-2 py-1 text-left text-xs"
    >
      {t('auth.signOut')}
    </button>
  );
}

export function Sidebar(): ReactNode {
  const t = useT();
  const open = useUiStore((state) => state.sidebarOpen);
  const closeSidebar = useUiStore((state) => state.closeSidebar);

  return (
    <>
      {/* Scrim, mobile only. Below the drawer, and below the app bar, which stays
          reachable so the ☰ that opened this can close it again. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <aside
        className={[
          'bg-surface border-subtle fixed bottom-0 left-0 z-40 w-64 overflow-y-auto border-r p-3',
          // Starts below the application bar rather than under it. The one
          // magic number in the shell, and it lives here alone: the bar is
          // sticky at the top on every route, so the drawer cannot use
          // `inset-y-0` without hiding its own close button behind it.
          'top-[3.25rem] lg:static lg:top-auto lg:z-auto',
          'transition-transform lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        aria-label={t('nav.label')}
      >
        {/* The name lives in the application bar now; repeating it here would be
            the second of two headings saying the same thing. */}
        <div className="mb-2 flex justify-end lg:hidden">
          <button
            type="button"
            onClick={closeSidebar}
            className="text-secondary hover:bg-hovered rounded px-2 py-1 text-sm"
            aria-label={t('nav.close')}
          >
            ✕
          </button>
        </div>

        <nav>
          <ul className="space-y-0.5">
            {NAV.map((entry) => (
              <li key={entry.to}>
                <NavLink to={entry.to} className={navClass} onClick={closeSidebar}>
                  {t(entry.labelKey)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <DashboardList t={t} />
        <TagList t={t} />

        <div className="border-subtle mt-6 space-y-2 border-t pt-3">
          <HealthLine t={t} />
          <SignOut t={t} />
        </div>
      </aside>
    </>
  );
}
