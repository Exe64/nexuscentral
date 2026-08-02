/**
 * Layout persistence against the **real** react-grid-layout.
 *
 * dashboard-grid.test.tsx stubs the library, which is right for what it proves
 * -- debouncing, memoisation, the maths. But the stub echoes back exactly the
 * objects it was handed, and that is what hid this: the real library returns
 * layout items carrying its own bookkeeping (`moved`, `static`) and without the
 * `minW`/`minH` we put in, so comparing `JSON.stringify(layouts)` to what came
 * back never matched. Every dashboard load issued a PATCH from a user who had
 * touched nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { defaultWidgetConfig, type Widget } from '@nexuscentral/shared';
import { Dashboard } from '../src/pages/Dashboard.tsx';
import { renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Longer than the grid's own debounce, so a PATCH has had every chance to fire. */
const AFTER_DEBOUNCE_MS = 1400;

function makeWidget(id: number, layout: Widget['layout']): Widget {
  return {
    id,
    dashboardId: 1,
    type: 'stats',
    title: `Widget ${id}`,
    config: defaultWidgetConfig('stats'),
    layout,
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

/** Two widgets side by side, each placed at every breakpoint. */
const PLACED = [
  makeWidget(1, {
    lg: { x: 4, y: 0, w: 4, h: 8 },
    md: { x: 0, y: 0, w: 5, h: 8 },
    sm: { x: 0, y: 0, w: 6, h: 8 },
    xs: { x: 0, y: 0, w: 2, h: 8 },
  }),
  makeWidget(2, {
    lg: { x: 0, y: 0, w: 4, h: 8 },
    md: { x: 5, y: 0, w: 5, h: 8 },
    sm: { x: 0, y: 8, w: 6, h: 8 },
    xs: { x: 0, y: 1, w: 2, h: 8 },
  }),
];

function stub(widgets: Widget[]) {
  return stubApi({
    'GET /api/dashboards': {
      body: { data: [{ id: 1, name: 'Home', position: 0, createdAt: '2026-07-01T00:00:00.000Z' }] },
    },
    'GET /api/dashboards/1': {
      body: {
        data: {
          id: 1,
          name: 'Home',
          position: 0,
          createdAt: '2026-07-01T00:00:00.000Z',
          widgets,
        },
      },
    },
    'GET /api/dashboards/1/data': {
      body: { widgets: {}, generatedAt: '2026-07-31T12:00:00.000Z' },
    },
    'PATCH /api/dashboards/1/layout': { body: { data: { updated: 6 } } },
  });
}

function render(): void {
  renderPage(
    <Routes>
      <Route path="/d/:dashboardId" element={<Dashboard />} />
    </Routes>,
    '/d/1',
  );
}

function patchCalls() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
}

describe('loading a dashboard nobody has touched', () => {
  it('writes nothing back', async () => {
    stub(PLACED);
    render();

    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/api/dashboards/1')),
      ).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, AFTER_DEBOUNCE_MS));

    // Reading a dashboard is not editing it. A write here is a write on every
    // page view, and one that can only ever store what was already there --
    // until the day it stores something subtly different.
    expect(patchCalls()).toEqual([]);
  }, 10_000);

  it('writes nothing back when widgets are placed only on lg', async () => {
    // The shape the seed produces, and the one a widget added today has: the
    // other breakpoints are filled in from the type's defaults at render time.
    stub([makeWidget(1, { lg: { x: 0, y: 0, w: 4, h: 8 } })]);
    render();

    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/api/dashboards/1')),
      ).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, AFTER_DEBOUNCE_MS));

    expect(patchCalls()).toEqual([]);
  }, 10_000);
});
