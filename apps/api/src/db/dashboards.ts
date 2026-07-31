/**
 * Dashboard and widget persistence.
 */

import type {
  Breakpoint,
  Dashboard,
  DashboardWithWidgets,
  Widget,
  WidgetType,
} from '@nexuscentral/shared';
import { query, transaction } from './pool.js';
import { HttpError } from '../http/errors.js';

interface DashboardRow {
  id: number;
  name: string;
  position: number;
  created_at: Date;
}

interface WidgetRow {
  id: number;
  dashboard_id: number;
  type: WidgetType;
  title: string;
  config: Record<string, unknown>;
  layout: Record<string, unknown>;
  created_at: Date;
}

function toDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    createdAt: row.created_at.toISOString(),
  };
}

function toWidget(row: WidgetRow): Widget {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    type: row.type,
    title: row.title,
    config: row.config,
    layout: row.layout,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listDashboards(): Promise<Dashboard[]> {
  const { rows } = await query<DashboardRow>(
    `SELECT id, name, position, created_at FROM dashboards ORDER BY position ASC, id ASC`,
  );
  return rows.map(toDashboard);
}

export async function getDashboard(id: number): Promise<DashboardWithWidgets | null> {
  const { rows } = await query<DashboardRow>(
    `SELECT id, name, position, created_at FROM dashboards WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;

  return { ...toDashboard(row), widgets: await listWidgets(id) };
}

export async function listWidgets(dashboardId: number): Promise<Widget[]> {
  const { rows } = await query<WidgetRow>(
    `SELECT id, dashboard_id, type, title, config, layout, created_at
       FROM widgets WHERE dashboard_id = $1 ORDER BY id ASC`,
    [dashboardId],
  );
  return rows.map(toWidget);
}

export async function getWidget(id: number): Promise<Widget | null> {
  const { rows } = await query<WidgetRow>(
    `SELECT id, dashboard_id, type, title, config, layout, created_at FROM widgets WHERE id = $1`,
    [id],
  );
  return rows[0] === undefined ? null : toWidget(rows[0]);
}

export async function createDashboard(input: {
  name: string;
  position?: number;
}): Promise<Dashboard> {
  const { rows } = await query<DashboardRow>(
    `INSERT INTO dashboards (name, position)
     VALUES ($1, coalesce($2, (SELECT coalesce(max(position), -1) + 1 FROM dashboards)))
     RETURNING id, name, position, created_at`,
    [input.name, input.position ?? null],
  );
  return toDashboard(rows[0] as DashboardRow);
}

export async function updateDashboard(
  id: number,
  patch: { name?: string; position?: number },
): Promise<Dashboard | null> {
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.position !== undefined) {
    params.push(patch.position);
    sets.push(`position = $${params.length}`);
  }
  if (sets.length === 0) {
    const existing = await listDashboards();
    return existing.find((dashboard) => dashboard.id === id) ?? null;
  }

  params.push(id);
  const { rows } = await query<DashboardRow>(
    `UPDATE dashboards SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, name, position, created_at`,
    params,
  );
  return rows[0] === undefined ? null : toDashboard(rows[0]);
}

export async function deleteDashboard(id: number): Promise<boolean> {
  // Widgets cascade.
  const result = await query(`DELETE FROM dashboards WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export interface CreateWidgetInput {
  dashboardId: number;
  type: WidgetType;
  title: string;
  config: Record<string, unknown>;
  layout: Record<string, unknown>;
}

export async function createWidget(input: CreateWidgetInput): Promise<Widget> {
  try {
    const { rows } = await query<WidgetRow>(
      `INSERT INTO widgets (dashboard_id, type, title, config, layout)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING id, dashboard_id, type, title, config, layout, created_at`,
      [
        input.dashboardId,
        input.type,
        input.title,
        JSON.stringify(input.config),
        JSON.stringify(input.layout),
      ],
    );
    return toWidget(rows[0] as WidgetRow);
  } catch (err) {
    // A foreign-key violation here means the dashboard is gone.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503') {
      throw HttpError.notFound('Dashboard');
    }
    throw err;
  }
}

export async function updateWidget(
  id: number,
  patch: { title?: string; config?: Record<string, unknown>; layout?: Record<string, unknown> },
): Promise<Widget | null> {
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (patch.title !== undefined) {
    params.push(patch.title);
    sets.push(`title = $${params.length}`);
  }
  if (patch.config !== undefined) {
    params.push(JSON.stringify(patch.config));
    sets.push(`config = $${params.length}::jsonb`);
  }
  if (patch.layout !== undefined) {
    params.push(JSON.stringify(patch.layout));
    sets.push(`layout = $${params.length}::jsonb`);
  }
  if (sets.length === 0) return getWidget(id);

  params.push(id);
  const { rows } = await query<WidgetRow>(
    `UPDATE widgets SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, dashboard_id, type, title, config, layout, created_at`,
    params,
  );
  return rows[0] === undefined ? null : toWidget(rows[0]);
}

export async function deleteWidget(id: number): Promise<boolean> {
  const result = await query(`DELETE FROM widgets WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
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
 * Persist a batch of layout changes in one transaction (03-SPEC-api.md 6).
 *
 * Merges into the existing `layout` object rather than replacing it: a drag on the
 * large breakpoint must not discard where the user put things on the small one.
 * Widget ids that do not belong to this dashboard are ignored rather than erroring
 * -- a stale tab racing a delete is not worth a 404.
 */
export async function saveLayouts(
  dashboardId: number,
  entries: readonly LayoutEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;

  return transaction(async (client) => {
    let updated = 0;

    for (const entry of entries) {
      const result = await client.query(
        `UPDATE widgets
            SET layout = layout || jsonb_build_object(
                  $3::text,
                  jsonb_build_object('x', $4::int, 'y', $5::int, 'w', $6::int, 'h', $7::int)
                )
          WHERE id = $1 AND dashboard_id = $2`,
        [entry.widgetId, dashboardId, entry.breakpoint, entry.x, entry.y, entry.w, entry.h],
      );
      updated += result.rowCount ?? 0;
    }

    return updated;
  });
}

/**
 * The most recent ingestion timestamp, used as a cache key component.
 *
 * A widget's payload can only change when an item arrives, a config changes, or
 * user state changes -- and the first is by far the most common.
 */
export async function lastItemInsertedAt(): Promise<string> {
  const { rows } = await query<{ at: Date | null }>(`SELECT max(fetched_at) AS at FROM items`);
  return rows[0]?.at?.toISOString() ?? 'never';
}

export async function countDashboards(): Promise<number> {
  const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM dashboards`);
  return rows[0]?.n ?? 0;
}
