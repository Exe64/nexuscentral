/**
 * `/d/:dashboardId` -- the grid (04-SPEC-frontend.md 3).
 *
 * Two requests on load: the structure, and the batched widget data. That second one
 * is the one that matters -- fifteen widgets fetching independently would mean
 * fifteen connections (decision D7).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Widget } from '@nexuscentral/shared';
import {
  useDashboard,
  useDashboardData,
  useDashboards,
  useDeleteWidget,
  useRefreshWidget,
  useSaveLayout,
  type LayoutEntry,
} from '../api/queries.ts';
import { AddWidgetDialog } from '../components/AddWidgetDialog.tsx';
import { ConfigureWidgetDialog } from '../components/ConfigureWidgetDialog.tsx';
import { DashboardGrid } from '../components/DashboardGrid.tsx';
import { DashboardSwitcher } from '../components/DashboardSwitcher.tsx';
import { useT } from '../i18n.tsx';
import { useUiStore } from '../stores/ui.ts';

export function Dashboard(): ReactNode {
  const t = useT();
  const params = useParams();
  const navigate = useNavigate();

  const dashboards = useDashboards();
  const routeId = params['dashboardId'] === undefined ? null : Number(params['dashboardId']);
  const dashboardId = routeId === null || Number.isNaN(routeId) ? null : routeId;

  // `/` redirects to the first dashboard; seeding guarantees there is one.
  useEffect(() => {
    if (dashboardId !== null) return;
    const first = dashboards.data?.[0];
    if (first !== undefined) navigate(`/d/${first.id}`, { replace: true });
  }, [dashboardId, dashboards.data, navigate]);

  const dashboard = useDashboard(dashboardId);
  const data = useDashboardData(dashboardId);

  // `.mutate` is stable across renders while the mutation object is not; the grid
  // hands these to memoised frames, so the identity matters.
  const { mutate: saveLayout } = useSaveLayout();
  const { mutate: refreshWidget } = useRefreshWidget();
  const { mutate: removeWidget } = useDeleteWidget();

  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<Widget | null>(null);

  const refreshRequests = useUiStore((state) => state.refreshRequests);
  useEffect(() => {
    if (refreshRequests === 0) return;
    void data.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRequests]);

  const handlePersistLayout = useCallback(
    (layouts: LayoutEntry[]) => {
      if (dashboardId === null) return;
      saveLayout({ dashboardId, layouts });
    },
    [dashboardId, saveLayout],
  );

  const handleRefreshWidget = useCallback(
    (widget: Widget) => {
      if (dashboardId === null) return;
      refreshWidget({ widgetId: widget.id, dashboardId });
    },
    [dashboardId, refreshWidget],
  );

  const handleRemoveWidget = useCallback(
    (widget: Widget) => {
      if (!window.confirm(t('dashboard.widget.deleteConfirm', { title: widget.title }))) return;
      removeWidget(widget);
    },
    [removeWidget, t],
  );

  const widgets = useMemo(() => dashboard.data?.widgets ?? [], [dashboard.data]);

  if (dashboards.isPending) return <p className="text-secondary">{t('common.loading')}</p>;

  if (dashboards.data !== undefined && dashboards.data.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-secondary">{t('dashboard.none')}</p>
        <DashboardSwitcher currentId={null} />
      </div>
    );
  }

  if (dashboard.error !== null) {
    return (
      <p role="alert" className="text-negative">
        {t('dashboard.error')}{' '}
        <button type="button" onClick={() => void dashboard.refetch()} className="underline">
          {t('common.retry')}
        </button>
      </p>
    );
  }

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DashboardSwitcher currentId={dashboardId} />

        <button
          type="button"
          onClick={() => setEditing((current) => !current)}
          aria-pressed={editing}
          className={[
            'ml-auto rounded border px-2 py-1 text-sm',
            editing
              ? 'bg-accent text-accent-fg border-strong'
              : 'border-subtle text-secondary hover:bg-hovered',
          ].join(' ')}
        >
          {editing ? t('dashboard.editing.done') : t('dashboard.editing.start')}
        </button>

        {editing && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="border-subtle text-secondary hover:bg-hovered rounded border px-2 py-1 text-sm"
          >
            {t('dashboard.addWidget')}
          </button>
        )}
      </div>

      {editing && <p className="text-muted mb-2 text-xs">{t('dashboard.editing.hint')}</p>}

      {widgets.length === 0 && !dashboard.isPending && (
        <p className="text-secondary">
          {t('dashboard.empty')}{' '}
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setAdding(true);
            }}
            className="text-accent underline"
          >
            {t('dashboard.addWidget')}
          </button>
        </p>
      )}

      <DashboardGrid
        widgets={widgets}
        payloads={data.data?.widgets}
        loading={data.isPending}
        editing={editing}
        onPersistLayout={handlePersistLayout}
        onRefreshWidget={handleRefreshWidget}
        onConfigureWidget={setConfiguring}
        onRemoveWidget={handleRemoveWidget}
      />

      {adding && dashboardId !== null && (
        <AddWidgetDialog dashboardId={dashboardId} onClose={() => setAdding(false)} />
      )}

      {configuring !== null && (
        <ConfigureWidgetDialog widget={configuring} onClose={() => setConfiguring(null)} />
      )}
    </section>
  );
}
