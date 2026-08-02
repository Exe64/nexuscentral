/**
 * The dashboard grid (04-SPEC-frontend.md 3).
 *
 * The performance requirement -- fifteen widgets dragging with no visible stutter --
 * is met by never putting the in-flight layout into React state. `onLayoutChange`
 * fires on every frame of a drag; setting state there would re-render every widget
 * body sixty times a second. Instead the layout lands in a ref, the grid owns its
 * own visual positions, and a debounced effect persists the result.
 *
 * `WidgetFrame` and every body are memoised, so the only thing that re-renders
 * during a drag is react-grid-layout itself.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Responsive, WidthProvider, type Layout, type Layouts } from 'react-grid-layout';
import {
  BREAKPOINTS,
  WIDGET_GEOMETRY,
  type Breakpoint,
  type Widget,
  type WidgetPayload,
} from '@nexuscentral/shared';
import { WidgetFrame } from './WidgetFrame.tsx';
import type { LayoutEntry } from '../api/queries.ts';

const ResponsiveGridLayout = WidthProvider(Responsive);

/** Straight from the spec; changing these changes every stored layout's meaning. */
export const GRID_BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480 } as const;
export const GRID_COLS = { lg: 12, md: 10, sm: 6, xs: 2 } as const;
export const ROW_HEIGHT = 40;
export const GRID_MARGIN: [number, number] = [16, 16];

/** `onLayoutChange` fires constantly during a drag; persist once it settles. */
export const LAYOUT_DEBOUNCE_MS = 1000;

export interface DashboardGridProps {
  widgets: readonly Widget[];
  payloads: Record<string, WidgetPayload> | undefined;
  loading: boolean;
  editing: boolean;
  onPersistLayout: (entries: LayoutEntry[]) => void;
  /**
   * Stable across renders, please. These are handed straight to a memoised frame,
   * so a fresh closure per render would undo the memoisation.
   */
  onRefreshWidget: (widget: Widget) => void;
  onConfigureWidget: (widget: Widget) => void;
  onRemoveWidget: (widget: Widget) => void;
}

/**
 * Build react-grid-layout's `layouts` from what is stored, filling in anything a
 * widget has not been placed at on a given breakpoint.
 */
export function toLayouts(widgets: readonly Widget[]): Layouts {
  const layouts: Layouts = { lg: [], md: [], sm: [], xs: [] };

  // Sorted by the large-breakpoint position so the single-column fallback reads
  // top-to-bottom, left-to-right rather than in insertion order.
  const ordered = [...widgets].sort((a, b) => {
    const first = a.layout.lg ?? { x: 0, y: 0 };
    const second = b.layout.lg ?? { x: 0, y: 0 };
    return first.y - second.y || first.x - second.x || a.id - b.id;
  });

  ordered.forEach((widget, index) => {
    const geometry = WIDGET_GEOMETRY[widget.type];

    for (const breakpoint of BREAKPOINTS) {
      const stored = widget.layout[breakpoint];
      const columns = GRID_COLS[breakpoint];

      const item: Layout = {
        i: String(widget.id),
        x: stored?.x ?? 0,
        y: stored?.y ?? index * geometry.defaultSize.h,
        w: Math.min(stored?.w ?? geometry.defaultSize.w, columns),
        h: stored?.h ?? geometry.defaultSize.h,
        minW: Math.min(geometry.minSize.w, columns),
        minH: geometry.minSize.h,
      };

      if (breakpoint === 'xs') {
        // Single column on a phone, in reading order. Nobody resizes widgets with
        // a thumb on a train.
        item.x = 0;
        item.y = index;
        item.w = columns;
        item.static = true;
      }

      layouts[breakpoint]?.push(item);
    }
  });

  return layouts;
}

/**
 * The bounds `PATCH /api/dashboards/:id/layout` enforces.
 *
 * Duplicated from the API's zod schema on purpose. The schema validates an
 * *array*, so a single out-of-range entry rejects the whole batch -- one widget
 * with an impossible height and nothing about the dashboard is saved, silently.
 * Checking here means the other widgets still get stored.
 */
const BOUNDS = {
  x: { min: 0, max: 24 },
  y: { min: 0, max: 500 },
  w: { min: 1, max: 24 },
  h: { min: 1, max: 100 },
} as const;

/** Whether the API would accept this entry, by the same rules it applies. */
export function isStorable(entry: LayoutEntry): boolean {
  if (!Number.isInteger(entry.widgetId) || entry.widgetId < 1) return false;
  for (const field of ['x', 'y', 'w', 'h'] as const) {
    const value = entry[field];
    const { min, max } = BOUNDS[field];
    if (!Number.isInteger(value) || value < min || value > max) return false;
  }
  return true;
}

/**
 * Flatten react-grid-layout's per-breakpoint layouts into what the API stores.
 *
 * `xs` is skipped: it is static and derived from the `lg` order, so persisting it
 * would store a position nobody chose and no drag can change.
 *
 * Anything the API would refuse is dropped rather than sent. Losing one
 * breakpoint of one widget is a bad outcome; losing the whole dashboard's layout
 * because of it is a worse one, and that is what a rejected batch costs.
 */
export function layoutEntries(layouts: Layouts): LayoutEntry[] {
  const entries: LayoutEntry[] = [];
  for (const breakpoint of BREAKPOINTS) {
    if (breakpoint === 'xs') continue;
    for (const item of layouts[breakpoint] ?? []) {
      const entry: LayoutEntry = {
        widgetId: Number(item.i),
        breakpoint: breakpoint as Breakpoint,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
      };
      if (isStorable(entry)) entries.push(entry);
    }
  }
  return entries;
}

/**
 * A stable signature of what would be persisted.
 *
 * Compared instead of `JSON.stringify(layouts)`, which never matched: what
 * react-grid-layout hands back carries its own bookkeeping (`moved`, `static`)
 * and drops the `minW`/`minH` we put in, so two identical layouts stringified
 * differently and the guard let every mount through. The result was a PATCH on
 * every dashboard load, from a user who had touched nothing.
 *
 * Sorted, because the per-breakpoint arrays come back in whatever order the
 * library kept them in -- measured, not assumed: a two-widget dashboard returned
 * `lg` in one order and `md` in the other.
 */
function signature(entries: readonly LayoutEntry[]): string {
  const ordered = [...entries].sort(
    (a, b) => a.widgetId - b.widgetId || a.breakpoint.localeCompare(b.breakpoint),
  );
  return JSON.stringify(ordered);
}

export function DashboardGrid({
  widgets,
  payloads,
  loading,
  editing,
  onPersistLayout,
  onRefreshWidget,
  onConfigureWidget,
  onRemoveWidget,
}: DashboardGridProps): ReactNode {
  // Recomputed only when the widget set changes -- not on every drag frame.
  const layouts = useMemo(() => toLayouts(widgets), [widgets]);

  /** What was loaded, so an unchanged layout is never persisted. */
  const persisted = useRef<string>(signature(layoutEntries(layouts)));
  const pending = useRef<Layouts | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    persisted.current = signature(layoutEntries(layouts));
  }, [layouts]);

  const flush = useCallback(() => {
    const next = pending.current;
    pending.current = null;
    if (next === null) return;

    const entries = layoutEntries(next);
    // An empty grid has nothing to say; the first paint happens before the
    // widgets have loaded and must not be mistaken for "the user cleared it".
    if (entries.length === 0) return;

    // Only PATCH when the layout actually differs from what was loaded.
    const next_signature = signature(entries);
    if (next_signature === persisted.current) return;
    persisted.current = next_signature;

    onPersistLayout(entries);
  }, [onPersistLayout]);

  const handleLayoutChange = useCallback(
    (_current: Layout[], all: Layouts) => {
      // Deliberately not setState: this fires on every frame of a drag.
      pending.current = all;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, LAYOUT_DEBOUNCE_MS);
    },
    [flush],
  );

  // A pending change must not be lost when the user navigates away mid-drag.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      flush();
    },
    [flush],
  );

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={layouts}
      breakpoints={GRID_BREAKPOINTS}
      cols={GRID_COLS}
      rowHeight={ROW_HEIGHT}
      margin={GRID_MARGIN}
      // Edit mode is explicit. Accidental drags while reading are the fastest way
      // to make a dashboard feel broken.
      isDraggable={editing}
      isResizable={editing}
      draggableHandle=".widget-drag-handle"
      // The action buttons sit inside the handle, so without this a click on
      // "Configure" starts a drag and nudges the widget on the way to the dialog.
      draggableCancel=".widget-no-drag"
      onLayoutChange={handleLayoutChange}
      // The frame handles its own overflow; letting the grid measure content would
      // make every cell jump as data arrives.
      measureBeforeMount={false}
      useCSSTransforms
      compactType="vertical"
    >
      {widgets.map((widget) => {
        const payload = payloads?.[String(widget.id)];
        return (
          <div key={String(widget.id)}>
            <WidgetFrame
              widget={widget}
              data={payload?.status === 'ok' ? payload.data : undefined}
              error={payload?.status === 'error' ? payload.error : null}
              loading={loading}
              editing={editing}
              onRefresh={onRefreshWidget}
              onConfigure={onConfigureWidget}
              onRemove={onRemoveWidget}
            />
          </div>
        );
      })}
    </ResponsiveGridLayout>
  );
}
