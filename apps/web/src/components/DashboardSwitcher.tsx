/**
 * Switching between dashboards, and creating one.
 *
 * Tabs rather than a dropdown: a single user with three dashboards should see all
 * three, not have to open a menu to remember what they are called.
 */

import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useCreateDashboard, useDashboards, useDeleteDashboard } from '../api/queries.ts';
import { useT } from '../i18n.tsx';

export function DashboardSwitcher({ currentId }: { currentId: number | null }): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const dashboards = useDashboards();
  const create = useCreateDashboard();
  const remove = useDeleteDashboard();

  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(dashboards.data ?? []).map((dashboard) => (
        <NavLink
          key={dashboard.id}
          to={`/d/${dashboard.id}`}
          className={({ isActive }) =>
            [
              'rounded border px-2 py-1 text-sm',
              isActive
                ? 'bg-accent-subtle border-strong text-primary'
                : 'border-subtle text-secondary hover:bg-hovered',
            ].join(' ')
          }
        >
          {dashboard.name}
        </NavLink>
      ))}

      {naming ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === '') return;
            create.mutate(
              { name: name.trim() },
              {
                onSuccess: (dashboard) => {
                  setName('');
                  setNaming(false);
                  navigate(`/d/${dashboard.id}`);
                },
              },
            );
          }}
          className="flex items-center gap-1"
        >
          <label className="sr-only" htmlFor="new-dashboard-name">
            {t('dashboard.new.name')}
          </label>
          <input
            id="new-dashboard-name"
            value={name}
            placeholder={t('dashboard.new.placeholder')}
            onChange={(event) => setName(event.target.value)}
            className="w-32 text-sm"
            autoFocus
          />
          <button
            type="submit"
            disabled={create.isPending}
            className="border-subtle text-secondary hover:bg-hovered rounded border px-2 py-1 text-sm"
          >
            {t('dashboard.new.create')}
          </button>
          <button
            type="button"
            onClick={() => {
              setNaming(false);
              setName('');
            }}
            className="text-secondary rounded px-1.5 py-1 text-sm"
          >
            {t('common.cancel')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="border-subtle text-secondary hover:bg-hovered rounded border px-2 py-1 text-sm"
        >
          {t('dashboard.new.add')}
        </button>
      )}

      {currentId !== null && (dashboards.data ?? []).length > 1 && (
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            const current = dashboards.data?.find((dashboard) => dashboard.id === currentId);
            if (current === undefined) return;
            if (!window.confirm(t('dashboard.delete.confirm', { name: current.name }))) return;
            remove.mutate(currentId, {
              onSuccess: () => {
                const next = dashboards.data?.find((dashboard) => dashboard.id !== currentId);
                navigate(next === undefined ? '/' : `/d/${next.id}`, { replace: true });
              },
            });
          }}
          className="text-negative hover:bg-hovered rounded px-1.5 py-1 text-sm"
        >
          {t('dashboard.delete')}
        </button>
      )}
    </div>
  );
}
