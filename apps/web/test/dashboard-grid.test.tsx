/**
 * The grid's own behaviour: layout maths, persistence, and the memoisation the
 * drag budget depends on (05-BUILD-PLAN.md, Phase 5 acceptance).
 *
 * react-grid-layout is replaced with a stub here. Not to avoid the library -- the
 * page tests render the real one -- but because a drag cannot be simulated in
 * happy-dom, and what needs proving is *our* code: that `onLayoutChange` firing
 * sixty times a second re-renders nothing, debounces to one PATCH, and never
 * persists a layout the user did not change.
 *
 * The widget registry is wrapped so every body render can be counted. That is the
 * automatable form of "profile it; if it stutters, the memo work was skipped": if
 * a body re-renders on a layout change, the memoisation was skipped.
 */

import type { ComponentType, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { Layouts } from 'react-grid-layout';
import { defaultWidgetConfig, type Widget, type WidgetPayload } from '@nexuscentral/shared';
import { I18nProvider } from '../src/i18n.tsx';
// Type-only, so these do not pull the mocked module in at runtime.
import type * as RegistryModule from '../src/widgets/registry.tsx';
import type { WidgetBodyProps, WidgetDefinition } from '../src/widgets/registry.tsx';

/** Body render counts, keyed by widget id. Reset before each test. */
const bodyRenders = vi.hoisted(() => new Map<string, number>());

/** Props the stubbed grid was last given, so the real props can be asserted. */
const gridProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  renders: 0,
}));

vi.mock('react-grid-layout', () => {
  const Responsive = (props: Record<string, unknown>): ReactNode => {
    gridProps.current = props;
    // Counting the stub's renders counts `DashboardGrid`'s: it is its only child.
    gridProps.renders += 1;
    return <div data-testid="grid">{props['children'] as ReactNode}</div>;
  };
  return {
    Responsive,
    // The real one measures the container; here it is a pass-through.
    WidthProvider: (Component: ComponentType<Record<string, unknown>>) => Component,
  };
});

vi.mock('../src/widgets/registry.tsx', async () => {
  const actual = await vi.importActual<typeof RegistryModule>('../src/widgets/registry.tsx');

  /**
   * Counts renders, then delegates to the real body. Deliberately not memoised:
   * if `WidgetFrame`'s own `memo` stops the subtree, this never runs, which is
   * exactly the signal the render-count assertions read.
   */
  function instrument(definition: WidgetDefinition): WidgetDefinition {
    const Real = definition.Body;
    const Counting = (props: WidgetBodyProps): ReactNode => {
      const id = String(props.config['__id'] ?? '?');
      bodyRenders.set(id, (bodyRenders.get(id) ?? 0) + 1);
      // A test-only hook for the error-boundary case: a body that throws.
      if (props.config['__throw'] === true) throw new Error('Widget exploded');
      return <Real {...props} />;
    };
    return { ...definition, Body: Counting };
  }

  const registry = Object.fromEntries(
    Object.entries(actual.WIDGET_REGISTRY).map(([type, definition]) => [
      type,
      definition === undefined ? undefined : instrument(definition),
    ]),
  );

  return {
    ...actual,
    WIDGET_REGISTRY: registry,
    widgetDefinition: (type: string) => registry[type],
    AVAILABLE_DEFINITIONS: Object.values(registry),
  };
});

const { DashboardGrid, GRID_BREAKPOINTS, GRID_COLS, LAYOUT_DEBOUNCE_MS, layoutEntries, toLayouts } =
  await import('../src/components/DashboardGrid.tsx');

function makeWidget(id: number, overrides: Partial<Widget> = {}): Widget {
  return {
    id,
    dashboardId: 1,
    type: 'feed',
    title: `Widget ${id}`,
    layout: { lg: { x: 0, y: (id - 1) * 8, w: 4, h: 8 } },
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
    // `__id` rides along in the config so the counting body knows who it is; the
    // real feed body ignores keys it does not know. Applied after the spread so an
    // override cannot drop it.
    config: {
      ...defaultWidgetConfig(overrides.type ?? 'feed'),
      ...overrides.config,
      __id: String(id),
    },
  };
}

function okPayload(items: unknown[] = []): WidgetPayload {
  return { status: 'ok', data: { items, total: items.length } };
}

interface Harness {
  persist: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  configure: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function renderGrid(
  widgets: Widget[],
  payloads: Record<string, WidgetPayload>,
  editing = false,
): Harness & { rerender: (next: Record<string, WidgetPayload>) => void } {
  const handlers: Harness = {
    persist: vi.fn(),
    refresh: vi.fn(),
    configure: vi.fn(),
    remove: vi.fn(),
  };

  const ui = (next: Record<string, WidgetPayload>): ReactNode => (
    <I18nProvider>
      <DashboardGrid
        widgets={widgets}
        payloads={next}
        loading={false}
        editing={editing}
        onPersistLayout={handlers.persist}
        onRefreshWidget={handlers.refresh}
        onConfigureWidget={handlers.configure}
        onRemoveWidget={handlers.remove}
      />
    </I18nProvider>
  );

  const result = render(ui(payloads));
  return { ...handlers, rerender: (next) => result.rerender(ui(next)) };
}

/** Fire the grid's `onLayoutChange` the way a drag would. */
function fireLayoutChange(layouts: Layouts): void {
  const handler = gridProps.current?.['onLayoutChange'] as
    ((current: unknown, all: Layouts) => void) | undefined;
  if (handler === undefined) throw new Error('grid never received onLayoutChange');
  act(() => {
    handler(layouts['lg'] ?? [], layouts);
  });
}

beforeEach(() => {
  bodyRenders.clear();
  gridProps.current = null;
  gridProps.renders = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toLayouts', () => {
  it('places a widget at its stored position on lg', () => {
    const layouts = toLayouts([makeWidget(1, { layout: { lg: { x: 4, y: 2, w: 5, h: 9 } } })]);
    expect(layouts['lg']?.[0]).toMatchObject({ i: '1', x: 4, y: 2, w: 5, h: 9 });
  });

  it('falls back to the type default where nothing is stored', () => {
    const layouts = toLayouts([makeWidget(1, { type: 'stats', layout: {} })]);
    // stats defaults to 4x5.
    expect(layouts['lg']?.[0]).toMatchObject({ w: 4, h: 5 });
  });

  it('makes xs a single static full-width column', () => {
    const layouts = toLayouts([makeWidget(1), makeWidget(2), makeWidget(3)]);
    // 390px lands in the xs bucket, where nothing drags and everything is 2 wide.
    expect(layouts['xs']).toEqual([
      expect.objectContaining({ i: '1', x: 0, y: 0, w: 2, static: true }),
      expect.objectContaining({ i: '2', x: 0, y: 1, w: 2, static: true }),
      expect.objectContaining({ i: '3', x: 0, y: 2, w: 2, static: true }),
    ]);
  });

  it('orders the single column by the lg position, not by insertion', () => {
    const widgets = [
      makeWidget(1, { layout: { lg: { x: 0, y: 20, w: 4, h: 8 } } }),
      makeWidget(2, { layout: { lg: { x: 0, y: 0, w: 4, h: 8 } } }),
    ];
    expect(toLayouts(widgets)['xs']?.map((item) => item.i)).toEqual(['2', '1']);
  });

  it('clamps width and minimum width to the column count of each breakpoint', () => {
    const layouts = toLayouts([makeWidget(1, { layout: { xs: { x: 0, y: 0, w: 9, h: 8 } } })]);
    // A feed's minW is 3, which does not fit in the 2-column xs grid.
    expect(layouts['xs']?.[0]?.w).toBe(2);
    expect(layouts['xs']?.[0]?.minW).toBe(2);
  });
});

describe('layoutEntries', () => {
  it('flattens every breakpoint except xs', () => {
    const entries = layoutEntries({
      lg: [{ i: '1', x: 1, y: 2, w: 3, h: 4 }],
      md: [{ i: '1', x: 0, y: 0, w: 5, h: 4 }],
      sm: [{ i: '1', x: 0, y: 0, w: 6, h: 4 }],
      xs: [{ i: '1', x: 0, y: 0, w: 2, h: 4 }],
    });

    expect(entries.map((entry) => entry.breakpoint)).toEqual(['lg', 'md', 'sm']);
    expect(entries[0]).toEqual({ widgetId: 1, breakpoint: 'lg', x: 1, y: 2, w: 3, h: 4 });
  });
});

describe('DashboardGrid persistence', () => {
  const widgets = [makeWidget(1), makeWidget(2)];
  const payloads = { '1': okPayload(), '2': okPayload() };

  it('does not persist the layout it was just given', () => {
    const grid = renderGrid(widgets, payloads);

    // react-grid-layout fires onLayoutChange on mount; that is not a user edit.
    fireLayoutChange(toLayouts(widgets));
    act(() => {
      vi.advanceTimersByTime(LAYOUT_DEBOUNCE_MS * 2);
    });

    expect(grid.persist).not.toHaveBeenCalled();
  });

  it('debounces a drag into a single PATCH', () => {
    const grid = renderGrid(widgets, payloads);
    const moved = toLayouts(widgets);

    // Sixty frames of a drag, one degree of movement each.
    for (let frame = 1; frame <= 60; frame += 1) {
      const next = structuredClone(moved);
      const first = next['lg']?.[0];
      if (first !== undefined) first.x = frame % 8;
      fireLayoutChange(next);
      act(() => {
        vi.advanceTimersByTime(16);
      });
    }

    expect(grid.persist).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(LAYOUT_DEBOUNCE_MS);
    });

    expect(grid.persist).toHaveBeenCalledTimes(1);
    const entries = grid.persist.mock.calls[0]?.[0] as ReturnType<typeof layoutEntries>;
    expect(entries.some((entry) => entry.breakpoint === 'xs')).toBe(false);
    expect(entries.find((entry) => entry.widgetId === 1 && entry.breakpoint === 'lg')?.x).toBe(
      60 % 8,
    );
  });

  it('persists every breakpoint it was handed, so a drag on lg does not lose sm', () => {
    const grid = renderGrid(widgets, payloads);
    const moved = toLayouts(widgets);
    const first = moved['lg']?.[0];
    if (first !== undefined) first.y = 99;

    fireLayoutChange(moved);
    act(() => {
      vi.advanceTimersByTime(LAYOUT_DEBOUNCE_MS);
    });

    const entries = grid.persist.mock.calls[0]?.[0] as ReturnType<typeof layoutEntries>;
    expect(new Set(entries.map((entry) => entry.breakpoint))).toEqual(new Set(['lg', 'md', 'sm']));
  });

  it('flushes a pending change on unmount rather than dropping it', () => {
    const handlers = { persist: vi.fn() };
    const view = render(
      <I18nProvider>
        <DashboardGrid
          widgets={widgets}
          payloads={payloads}
          loading={false}
          editing
          onPersistLayout={handlers.persist}
          onRefreshWidget={vi.fn()}
          onConfigureWidget={vi.fn()}
          onRemoveWidget={vi.fn()}
        />
      </I18nProvider>,
    );

    const moved = toLayouts(widgets);
    const first = moved['lg']?.[0];
    if (first !== undefined) first.y = 42;
    fireLayoutChange(moved);

    // Navigating away 200ms into the 1000ms debounce must not lose the drag.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    view.unmount();

    expect(handlers.persist).toHaveBeenCalledTimes(1);
  });
});

describe('a 390px viewport', () => {
  it('falls into the xs bucket, which is two columns wide', () => {
    // react-grid-layout picks the largest breakpoint whose width is <= the
    // container. Nothing is <= 390, so it falls back to the smallest key.
    const applicable = Object.entries(GRID_BREAKPOINTS)
      .filter(([, width]) => width <= 390)
      .map(([name]) => name);

    expect(applicable).toEqual([]);
    expect(GRID_COLS.xs).toBe(2);
  });

  it('makes every widget full width and undraggable, even in edit mode', () => {
    renderGrid([makeWidget(1), makeWidget(2)], { '1': okPayload(), '2': okPayload() }, true);

    const layouts = gridProps.current?.['layouts'] as Layouts;
    for (const item of layouts['xs'] ?? []) {
      // `static` wins over `isDraggable`, so a thumb on a train cannot rearrange
      // the dashboard by accident.
      expect(item.static).toBe(true);
      expect(item.w).toBe(GRID_COLS.xs);
      expect(item.x).toBe(0);
    }
  });
});

describe('DashboardGrid edit mode', () => {
  it('disables drag and resize outside edit mode', () => {
    renderGrid([makeWidget(1)], { '1': okPayload() }, false);
    expect(gridProps.current?.['isDraggable']).toBe(false);
    expect(gridProps.current?.['isResizable']).toBe(false);
  });

  it('enables them in edit mode, behind an explicit handle', () => {
    renderGrid([makeWidget(1)], { '1': okPayload() }, true);
    expect(gridProps.current?.['isDraggable']).toBe(true);
    expect(gridProps.current?.['isResizable']).toBe(true);
    // Only the title bar drags; the body stays clickable and scrollable.
    expect(gridProps.current?.['draggableHandle']).toBe('.widget-drag-handle');
  });
});

describe('DashboardGrid memoisation', () => {
  /**
   * The automatable form of "15 widgets drag smoothly with no visible stutter".
   *
   * Two separate guarantees, asserted separately because either one alone would
   * hide the other's absence:
   *
   * - the grid itself does not re-render, because the in-flight layout lives in a
   *   ref (putting it in state would re-render on every frame of the drag);
   * - no widget body re-renders, because the frames are memoised on stable props.
   */
  it('re-renders neither the grid nor any widget body while the layout is changing', () => {
    const widgets = Array.from({ length: 15 }, (_, index) => makeWidget(index + 1));
    const payloads = Object.fromEntries(widgets.map((w) => [String(w.id), okPayload()]));
    renderGrid(widgets, payloads);

    expect(bodyRenders.size).toBe(15);
    const afterMount = new Map(bodyRenders);
    const gridRendersAfterMount = gridProps.renders;

    const moved = toLayouts(widgets);
    for (let frame = 1; frame <= 60; frame += 1) {
      const next = structuredClone(moved);
      const first = next['lg']?.[0];
      if (first !== undefined) first.x = frame % 8;
      fireLayoutChange(next);
    }

    expect(gridProps.renders).toBe(gridRendersAfterMount);
    expect([...bodyRenders]).toEqual([...afterMount]);
  });

  it('re-renders only the widget whose data changed', () => {
    const widgets = [makeWidget(1), makeWidget(2), makeWidget(3)];
    const payloads = { '1': okPayload(), '2': okPayload(), '3': okPayload() };
    const grid = renderGrid(widgets, payloads);

    const before = new Map(bodyRenders);
    grid.rerender({ ...payloads, '2': okPayload([]) });

    expect(bodyRenders.get('1')).toBe(before.get('1'));
    expect(bodyRenders.get('3')).toBe(before.get('3'));
    expect(bodyRenders.get('2')).toBe((before.get('2') ?? 0) + 1);
  });
});

describe('a widget that fails', () => {
  it('renders an inline error and leaves its neighbours working', () => {
    const widgets = [makeWidget(1), makeWidget(2)];
    renderGrid(widgets, {
      '1': { status: 'error', error: { code: 'UPSTREAM_ERROR', message: 'Resolver gave up' } },
      '2': okPayload(),
    });

    expect(screen.getByText('Resolver gave up')).toBeDefined();
    // The other widget is untouched: its title and its body both rendered.
    expect(screen.getByText('Widget 2')).toBeDefined();
    expect(bodyRenders.get('2')).toBe(1);
  });

  it('catches a body that throws instead of blanking the dashboard', () => {
    // React logs the caught error; the boundary is the point, not the noise.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const widgets = [makeWidget(1, { config: { __throw: true } }), makeWidget(2)];
    renderGrid(widgets, { '1': okPayload(), '2': okPayload() });

    expect(screen.getByText('Widget exploded')).toBeDefined();
    expect(screen.getByText('Widget 2')).toBeDefined();
    expect(bodyRenders.get('2')).toBeGreaterThanOrEqual(1);

    consoleError.mockRestore();
  });
});
