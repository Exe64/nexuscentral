/**
 * The persistent left sidebar (04-SPEC-frontend.md 2).
 *
 * Navigation, and the tag list with unread counts. On `lg+` it is always there; on
 * smaller screens it slides over and closes when a link is followed, because a nav
 * panel that stays open after navigating hides the thing you navigated to.
 *
 * The dashboard switcher arrives in Phase 5 with dashboards.
 */

import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useHealth, useTags } from '../api/queries.ts';
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

export function Sidebar(): ReactNode {
  const t = useT();
  const open = useUiStore((state) => state.sidebarOpen);
  const closeSidebar = useUiStore((state) => state.closeSidebar);

  return (
    <>
      {/* Scrim, mobile only. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <aside
        className={[
          'bg-surface border-subtle fixed inset-y-0 left-0 z-40 w-64 overflow-y-auto border-r p-3',
          'transition-transform lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        aria-label={t('nav.label')}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-primary px-2 text-sm font-semibold">{t('app.name')}</span>
          <button
            type="button"
            onClick={closeSidebar}
            className="text-secondary hover:bg-hovered rounded px-2 py-1 text-sm lg:hidden"
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

        <TagList t={t} />

        <div className="mt-6 border-t border-subtle pt-3">
          <HealthLine t={t} />
        </div>
      </aside>
    </>
  );
}
