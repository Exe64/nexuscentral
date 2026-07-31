/**
 * Dashboard, widget and batched-data routes (03-SPEC-api.md 6).
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  AVAILABLE_WIDGET_TYPES,
  BREAKPOINTS,
  parseWidgetConfig,
  WIDGET_GEOMETRY,
  WIDGET_TYPES,
  type DashboardData,
  type Widget,
  type WidgetPayload,
} from '@nexuscentral/shared';
import {
  createDashboard,
  createWidget,
  deleteDashboard,
  deleteWidget,
  getDashboard,
  getWidget,
  lastItemInsertedAt,
  listDashboards,
  listWidgets,
  saveLayouts,
  updateDashboard,
  updateWidget,
} from '../../db/dashboards.js';
import { throughCache, invalidateWidget, widgetCacheKey } from '../../widgets/cache.js';
import { WIDGET_RESOLVERS } from '../../widgets/resolvers.js';
import { logger } from '../../logger.js';
import { HttpError } from '../errors.js';
import { intParam, parseBody, shortText } from '../validation.js';

export const dashboardsRouter: Router = Router();

const log = logger.child({ component: 'dashboards' });

const dashboardCreateSchema = z.object({
  name: shortText(80),
  position: z.number().int().min(0).max(999).optional(),
});

const dashboardPatchSchema = z
  .object({
    name: shortText(80).optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field' });

const gridPosition = z.object({
  x: z.number().int().min(0).max(24),
  y: z.number().int().min(0).max(500),
  w: z.number().int().min(1).max(24),
  h: z.number().int().min(1).max(100),
});

const layoutSchema = z.record(z.enum(BREAKPOINTS), gridPosition).default({});

const widgetCreateSchema = z.object({
  dashboardId: z.number().int().positive(),
  type: z.enum(WIDGET_TYPES),
  title: shortText(120),
  config: z.unknown().optional(),
  layout: layoutSchema,
});

const widgetPatchSchema = z
  .object({
    title: shortText(120).optional(),
    config: z.unknown().optional(),
    layout: layoutSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field' });

const layoutBatchSchema = z.object({
  layouts: z
    .array(
      z.object({
        widgetId: z.number().int().positive(),
        breakpoint: z.enum(BREAKPOINTS),
        x: z.number().int().min(0).max(24),
        y: z.number().int().min(0).max(500),
        w: z.number().int().min(1).max(24),
        h: z.number().int().min(1).max(100),
      }),
    )
    .max(500),
});

// --- dashboards ------------------------------------------------------------

dashboardsRouter.get('/dashboards', async (_req, res) => {
  res.json({ data: await listDashboards() });
});

dashboardsRouter.post('/dashboards', async (req, res) => {
  const body = parseBody(dashboardCreateSchema, req);
  res.status(201).json({ data: await createDashboard(body) });
});

dashboardsRouter.get('/dashboards/:id', async (req, res) => {
  const dashboard = await getDashboard(intParam(req, 'id'));
  if (dashboard === null) throw HttpError.notFound('Dashboard');
  // Structure only. The payloads come from /data, which is the one request that
  // matters for the number of connections a dashboard opens.
  res.json({ data: dashboard });
});

dashboardsRouter.patch('/dashboards/:id', async (req, res) => {
  const body = parseBody(dashboardPatchSchema, req);
  const dashboard = await updateDashboard(intParam(req, 'id'), body);
  if (dashboard === null) throw HttpError.notFound('Dashboard');
  res.json({ data: dashboard });
});

dashboardsRouter.delete('/dashboards/:id', async (req, res) => {
  const deleted = await deleteDashboard(intParam(req, 'id'));
  if (!deleted) throw HttpError.notFound('Dashboard');
  res.status(204).end();
});

/**
 * `PATCH /api/dashboards/:id/layout` -- bulk layout persistence.
 *
 * Called on drag and resize end, debounced client-side. One transaction for the
 * whole batch, so a dashboard is never left half-moved.
 */
dashboardsRouter.patch('/dashboards/:id/layout', async (req, res) => {
  const id = intParam(req, 'id');
  const body = parseBody(layoutBatchSchema, req);

  const dashboard = await getDashboard(id);
  if (dashboard === null) throw HttpError.notFound('Dashboard');

  const updated = await saveLayouts(id, body.layouts);
  res.json({ data: { updated } });
});

/**
 * `GET /api/dashboards/:id/data` -- every widget's payload, keyed by widget id.
 *
 * This is decision D7: fifteen widgets fetching independently would mean fifteen
 * connections on load and rate limiting reimplemented in the browser.
 *
 * A single failing widget degrades to a `status: "error"` entry and never fails
 * the response -- one broken widget must not blank the dashboard.
 */
dashboardsRouter.get('/dashboards/:id/data', async (req, res) => {
  const id = intParam(req, 'id');

  const dashboard = await getDashboard(id);
  if (dashboard === null) throw HttpError.notFound('Dashboard');

  res.json(await resolveWidgets(dashboard.widgets));
});

/** `POST /api/widgets/:id/data` -- refresh one widget without reloading the rest. */
dashboardsRouter.post('/widgets/:id/data', async (req, res) => {
  const widget = await getWidget(intParam(req, 'id'));
  if (widget === null) throw HttpError.notFound('Widget');

  const payload = await resolveWidgets([widget]);
  res.json(payload);
});

async function resolveWidgets(widgets: readonly Widget[]): Promise<DashboardData> {
  const insertedAt = await lastItemInsertedAt();

  const settled = await Promise.all(
    widgets.map(async (widget): Promise<[string, WidgetPayload]> => {
      try {
        const data = await throughCache(widgetCacheKey(widget, insertedAt), () =>
          WIDGET_RESOLVERS[widget.type](widget),
        );
        return [String(widget.id), { status: 'ok', data }];
      } catch (err) {
        // Logged, then handed back as data. The dashboard renders regardless.
        log.warn({ err, widgetId: widget.id, type: widget.type }, 'Widget failed to resolve');
        return [
          String(widget.id),
          {
            status: 'error',
            error:
              err instanceof HttpError
                ? { code: err.code, message: err.message }
                : {
                    code: 'INTERNAL',
                    message: err instanceof Error ? err.message : 'Could not load this widget',
                  },
          },
        ];
      }
    }),
  );

  return {
    widgets: Object.fromEntries(settled),
    generatedAt: new Date().toISOString(),
  };
}

// --- widgets ---------------------------------------------------------------

dashboardsRouter.post('/widgets', async (req, res) => {
  const body = parseBody(widgetCreateSchema, req);

  if (!AVAILABLE_WIDGET_TYPES.includes(body.type)) {
    throw HttpError.validation(`${body.type} widgets are not supported by this build yet.`);
  }

  // Rejected here rather than discovered at render time.
  const config = parseWidgetConfig(body.type, body.config);

  const geometry = WIDGET_GEOMETRY[body.type];
  const layout =
    Object.keys(body.layout).length > 0
      ? body.layout
      : // Appended at the bottom of the grid at its default size. `y` is a large
        // number rather than a computed one: react-grid-layout compacts vertically,
        // so "below everything" is enough and needs no knowledge of the rest.
        {
          lg: { x: 0, y: 999, ...geometry.defaultSize },
          md: { x: 0, y: 999, ...geometry.defaultSize },
          sm: { x: 0, y: 999, w: 6, h: geometry.defaultSize.h },
          xs: { x: 0, y: 999, w: 2, h: geometry.defaultSize.h },
        };

  const widget = await createWidget({
    dashboardId: body.dashboardId,
    type: body.type,
    title: body.title,
    config,
    layout,
  });

  res.status(201).json({ data: widget });
});

dashboardsRouter.patch('/widgets/:id', async (req, res) => {
  const id = intParam(req, 'id');
  const body = parseBody(widgetPatchSchema, req);

  const existing = await getWidget(id);
  if (existing === null) throw HttpError.notFound('Widget');

  const patch: Parameters<typeof updateWidget>[1] = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.layout !== undefined) patch.layout = body.layout;
  if (body.config !== undefined) {
    // Validated against the widget's own type, not whatever the body claims.
    patch.config = parseWidgetConfig(existing.type, body.config);
  }

  const widget = await updateWidget(id, patch);
  if (widget === null) throw HttpError.notFound('Widget');

  // The cached payload was computed from the old config.
  invalidateWidget(id);

  res.json({ data: widget });
});

dashboardsRouter.delete('/widgets/:id', async (req, res) => {
  const id = intParam(req, 'id');
  const deleted = await deleteWidget(id);
  if (!deleted) throw HttpError.notFound('Widget');
  invalidateWidget(id);
  res.status(204).end();
});

/** The widget types this build offers, with their geometry. Backs the type picker. */
dashboardsRouter.get('/widget-types', (_req, res) => {
  res.json({
    data: AVAILABLE_WIDGET_TYPES.map((type) => ({
      type,
      ...WIDGET_GEOMETRY[type],
      defaultConfig: parseWidgetConfig(type, {}),
    })),
  });
});

/** Backs the `widgets` listing for a dashboard without its data. */
dashboardsRouter.get('/dashboards/:id/widgets', async (req, res) => {
  const id = intParam(req, 'id');
  const dashboard = await getDashboard(id);
  if (dashboard === null) throw HttpError.notFound('Dashboard');
  res.json({ data: await listWidgets(id) });
});
