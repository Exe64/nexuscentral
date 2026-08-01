/**
 * The bar under the application bar: where you are.
 *
 * It is the only place a page name is rendered. The four pages that used to
 * print their own heading now pass only a description to `PageHeader`, because
 * two headings saying "Sources" one above the other is not a design, it is an
 * oversight.
 *
 * Dashboards are resolved to their actual name rather than a generic label:
 * "Home" and "Security" are the whole point of having several, and a bar that
 * said "Dashboard" for both would be worse than the old top bar it replaces.
 */

import type { ReactNode } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useDashboards } from '../api/queries.ts';
import { useT, type Translate } from '../i18n.tsx';

const TITLE_KEYS: Record<string, string> = {
  '/reader': 'reader.title',
  '/sources': 'sources.title',
  '/tags': 'tags.title',
  '/rules': 'rules.title',
  '/settings': 'settings.title',
};

/**
 * The name for the current route.
 *
 * Exported for the test: the interesting cases are the dashboard ones, and
 * asserting them through the rendered bar would need the whole router.
 */
export function pageTitle(
  pathname: string,
  dashboardName: string | undefined,
  t: Translate,
): string {
  const key = TITLE_KEYS[pathname];
  if (key !== undefined) return t(key);
  // `/` and `/d/:id` are both the grid. Until the list loads there is no name to
  // show, and a generic label is better than an empty bar that then jumps.
  return dashboardName ?? t('pagebar.dashboard');
}

export function PageBar(): ReactNode {
  const t = useT();
  const location = useLocation();
  const params = useParams();

  // Already in the cache: the sidebar lists dashboards on every route.
  const dashboards = useDashboards();
  const routeId = params['dashboardId'];
  const dashboardName =
    routeId === undefined
      ? dashboards.data?.[0]?.name
      : dashboards.data?.find((entry) => String(entry.id) === routeId)?.name;

  return (
    <div className="bg-base border-subtle flex items-center gap-3 border-b px-3 py-2 sm:px-4">
      <h1 className="text-primary text-sm font-semibold">
        {pageTitle(location.pathname, dashboardName, t)}
      </h1>
    </div>
  );
}
