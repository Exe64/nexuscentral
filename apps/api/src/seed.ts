/**
 * First-boot seed (01-SPEC-data-model.md 4).
 *
 * When `dashboards` is empty, create `Home` with three widgets. No tags, sources or
 * rules: the empty states in the UI are genuinely useful and inventing content the
 * user did not ask for would be worse than showing them.
 *
 * Idempotent, and deliberately keyed on "no dashboards at all" rather than a flag:
 * a user who deletes every dashboard gets one back, which is more useful than an
 * app with nowhere to go.
 */

import { defaultWidgetConfig, WIDGET_GEOMETRY, type WidgetType } from '@nexuscentral/shared';
import { countDashboards, createDashboard, createWidget } from './db/dashboards.js';
import { logger } from './logger.js';

const log = logger.child({ component: 'seed' });

interface SeedWidget {
  type: WidgetType;
  title: string;
  config?: Record<string, unknown>;
  position: { lg: [number, number]; md: [number, number]; sm: [number, number] };
}

const HOME_WIDGETS: SeedWidget[] = [
  {
    type: 'feed',
    title: 'Top items',
    // No tag filter, sorted by score: the point of the default dashboard is to
    // show what the rules think matters, across everything.
    config: { sort: 'score', limit: 15 },
    position: { lg: [0, 0], md: [0, 0], sm: [0, 0] },
  },
  {
    type: 'alerts',
    title: 'Alerts',
    position: { lg: [4, 0], md: [4, 0], sm: [0, 8] },
  },
  {
    type: 'source_health',
    title: 'Source health',
    position: { lg: [8, 0], md: [4, 6], sm: [0, 14] },
  },
];

export async function seedIfEmpty(): Promise<{ seeded: boolean }> {
  if ((await countDashboards()) > 0) return { seeded: false };

  const dashboard = await createDashboard({ name: 'Home', position: 0 });

  for (const widget of HOME_WIDGETS) {
    const geometry = WIDGET_GEOMETRY[widget.type];
    await createWidget({
      dashboardId: dashboard.id,
      type: widget.type,
      title: widget.title,
      config: { ...defaultWidgetConfig(widget.type), ...(widget.config ?? {}) },
      layout: {
        lg: { x: widget.position.lg[0], y: widget.position.lg[1], ...geometry.defaultSize },
        md: { x: widget.position.md[0], y: widget.position.md[1], ...geometry.defaultSize },
        sm: { x: widget.position.sm[0], y: widget.position.sm[1], w: 6, h: geometry.defaultSize.h },
        xs: { x: 0, y: widget.position.sm[1], w: 2, h: geometry.defaultSize.h },
      },
    });
  }

  log.info(
    { dashboardId: dashboard.id, widgets: HOME_WIDGETS.length },
    'Seeded the Home dashboard',
  );
  return { seeded: true };
}
