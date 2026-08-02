/**
 * A layout save that fails has to say so.
 *
 * It used to fail in silence: `useSaveLayout` was destructured for its `mutate`
 * alone and its error was never read, so a rejected PATCH left no trace anywhere
 * on screen. The only symptom was the arrangement being back where it started
 * after a refresh -- which reads as "widget positions are not saved" rather than
 * as an error, and sends you looking in the wrong place.
 *
 * `useSaveLayout` is stubbed here rather than driven through the grid, because a
 * drag cannot be simulated in this environment and what needs proving is the
 * page's own contract: given a mutation in an error state, show it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { defaultWidgetConfig, type Widget } from '@nexuscentral/shared';
import type * as QueriesModule from '../src/api/queries.ts';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  error: null as Error | null,
}));

vi.mock('../src/api/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useSaveLayout: () => ({ mutate: mocks.mutate, error: mocks.error }),
}));

const { Dashboard } = await import('../src/pages/Dashboard.tsx');
const { renderPage, stubApi } = await import('./helpers.tsx');

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.error = null;
});

const widget: Widget = {
  id: 1,
  dashboardId: 1,
  type: 'stats',
  title: 'Widget 1',
  config: defaultWidgetConfig('stats'),
  layout: { lg: { x: 0, y: 0, w: 4, h: 8 } },
  createdAt: '2026-07-01T00:00:00.000Z',
};

function render(): void {
  stubApi({
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
          widgets: [widget],
        },
      },
    },
    'GET /api/dashboards/1/data': {
      body: { widgets: {}, generatedAt: '2026-07-31T12:00:00.000Z' },
    },
  });

  renderPage(
    <Routes>
      <Route path="/d/:dashboardId" element={<Dashboard />} />
    </Routes>,
    '/d/1',
  );
}

describe('a layout that could not be saved', () => {
  it('reports it, and says what the user will see', async () => {
    mocks.error = new Error('Database unavailable.');
    render();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Database unavailable.');
    // The consequence matters as much as the cause: without it, the message and
    // the symptom look like two unrelated problems.
    expect(alert.textContent).toContain('back where it was after a refresh');
  });

  it('says nothing while saves are succeeding', async () => {
    render();

    await waitFor(() => {
      expect(screen.getByText('Widget 1')).toBeTruthy();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
