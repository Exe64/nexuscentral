/**
 * The dashboard page, against the real react-grid-layout.
 *
 * The grid's internals are covered in dashboard-grid.test.tsx with a stub; here
 * the library is real, so what is proven is the wiring: which requests a load
 * makes, what the empty and error states say, and that adding, configuring and
 * removing a widget hit the endpoints the API actually exposes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { defaultWidgetConfig, type Widget } from '@nexuscentral/shared';
import { Dashboard } from '../src/pages/Dashboard.tsx';
import { HEALTH_OK, makeItem, renderPage, stubApi } from './helpers.tsx';

/**
 * The page reads `:dashboardId` from the route, so it has to be mounted behind
 * one -- rendering it bare would leave every test looking at the redirect path.
 */
function renderDashboard(route: string): void {
  renderPage(
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/d/:dashboardId" element={<Dashboard />} />
    </Routes>,
    route,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeWidget(id: number, overrides: Partial<Widget> = {}): Widget {
  return {
    id,
    dashboardId: 1,
    type: 'feed',
    title: `Widget ${id}`,
    layout: { lg: { x: 0, y: (id - 1) * 8, w: 4, h: 8 } },
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
    config: { ...defaultWidgetConfig(overrides.type ?? 'feed'), ...overrides.config },
  };
}

const DASHBOARDS = {
  body: {
    data: [
      { id: 1, name: 'Home', position: 0, createdAt: '2026-07-01T00:00:00.000Z' },
      { id: 2, name: 'Security', position: 1, createdAt: '2026-07-01T00:00:00.000Z' },
    ],
  },
};

function feedData(items: unknown[]): { status: 'ok'; data: unknown } {
  return { status: 'ok', data: { items, total: items.length } };
}

describe('Dashboard', () => {
  it('loads a dashboard with exactly one data request', async () => {
    const { calls } = stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': {
        body: { data: { ...DASHBOARDS.body.data[0], widgets: [makeWidget(1), makeWidget(2)] } },
      },
      'GET /api/dashboards/1/data': {
        body: {
          widgets: { '1': feedData([makeItem()]), '2': feedData([]) },
          generatedAt: '2026-07-30T12:00:00.000Z',
        },
      },
      'GET /api/tags': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
    });

    renderDashboard('/d/1');

    expect(await screen.findByText('Announcing AOS 7.2')).toBeDefined();

    // Decision D7: one batched call, not one per widget. Two widgets, one request.
    const dataCalls = calls.filter((call) => call.includes('/dashboards/1/data'));
    expect(dataCalls).toHaveLength(1);
    expect(calls.filter((call) => call.includes('/widgets/'))).toEqual([]);
  });

  it('redirects "/" to the first dashboard', async () => {
    const { calls } = stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': { body: { data: { ...DASHBOARDS.body.data[0], widgets: [] } } },
      'GET /api/dashboards/1/data': {
        body: { widgets: {}, generatedAt: '2026-07-30T12:00:00.000Z' },
      },
      'GET /api/health': HEALTH_OK,
    });

    renderDashboard('/');

    await waitFor(() => {
      expect(calls).toContain('GET /api/dashboards/1');
    });
  });

  it('renders an inline error for a failed widget and leaves the others working', async () => {
    stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': {
        body: { data: { ...DASHBOARDS.body.data[0], widgets: [makeWidget(1), makeWidget(2)] } },
      },
      'GET /api/dashboards/1/data': {
        body: {
          widgets: {
            '1': { status: 'error', error: { code: 'INTERNAL', message: 'Resolver gave up' } },
            '2': feedData([makeItem()]),
          },
          generatedAt: '2026-07-30T12:00:00.000Z',
        },
      },
      'GET /api/tags': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
    });

    renderDashboard('/d/1');

    expect(await screen.findByText('Resolver gave up')).toBeDefined();
    // The neighbour rendered its data, not a placeholder.
    expect(screen.getByText('Announcing AOS 7.2')).toBeDefined();
  });

  it('invites the user to add a widget when the dashboard is empty', async () => {
    stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': { body: { data: { ...DASHBOARDS.body.data[0], widgets: [] } } },
      'GET /api/dashboards/1/data': {
        body: { widgets: {}, generatedAt: '2026-07-30T12:00:00.000Z' },
      },
      'GET /api/health': HEALTH_OK,
    });

    renderDashboard('/d/1');

    expect(await screen.findByText('This dashboard has no widgets yet.')).toBeDefined();
  });

  it('offers every dashboard as a tab', async () => {
    stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': { body: { data: { ...DASHBOARDS.body.data[0], widgets: [] } } },
      'GET /api/dashboards/1/data': {
        body: { widgets: {}, generatedAt: '2026-07-30T12:00:00.000Z' },
      },
      'GET /api/health': HEALTH_OK,
    });

    renderDashboard('/d/1');

    expect(await screen.findByRole('link', { name: 'Home' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Security' })).toBeDefined();
  });
});

describe('editing a dashboard', () => {
  const structure = {
    body: { data: { ...DASHBOARDS.body.data[0], widgets: [makeWidget(1)] } },
  };
  const data = {
    body: {
      widgets: { '1': feedData([]) },
      generatedAt: '2026-07-30T12:00:00.000Z',
    },
  };

  it('hides the widget actions until edit mode is on', async () => {
    stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': structure,
      'GET /api/dashboards/1/data': data,
      'GET /api/tags': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
    });

    renderDashboard('/d/1');
    await screen.findByText('Widget 1');

    // Reading mode: a refresh button, and nothing that can destroy anything.
    expect(screen.getByRole('button', { name: 'Refresh this widget' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));

    expect(screen.getByRole('button', { name: 'Configure' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Refresh this widget' })).toBeNull();
  });

  it('adds a widget through the dialog', async () => {
    const { calls } = stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': structure,
      'GET /api/dashboards/1/data': data,
      'GET /api/tags': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
      'POST /api/widgets': { status: 201, body: { data: makeWidget(2, { type: 'stats' }) } },
    });

    renderDashboard('/d/1');
    await screen.findByText('Widget 1');

    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));

    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Stats/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(calls).toContain('POST /api/widgets');
    });
    // The dialog closes on success rather than leaving a stale form open.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('offers custom_api now that this build can render it', async () => {
    stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': structure,
      'GET /api/dashboards/1/data': data,
      'GET /api/tags': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
    });

    renderDashboard('/d/1');
    await screen.findByText('Widget 1');
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));

    // It was withheld until Phase 6 on purpose: offering a type the client
    // cannot render would let a user add a widget that only ever shows an error.
    // The list still comes from the client registry, not from the server.
    expect(within(screen.getByRole('dialog')).getByText(/Custom API/)).toBeDefined();
  });

  it('saves a config change through PATCH /api/widgets/:id', async () => {
    const { calls } = stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': structure,
      'GET /api/dashboards/1/data': data,
      'GET /api/tags': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
      'PATCH /api/widgets/1': { body: { data: makeWidget(1, { title: 'Renamed' }) } },
    });

    renderDashboard('/d/1');
    await screen.findByText('Widget 1');

    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    await userEvent.click(screen.getByRole('button', { name: 'Configure' }));

    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(calls).toContain('PATCH /api/widgets/1');
    });
  });

  it('confirms before removing a widget', async () => {
    const { calls } = stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': structure,
      'GET /api/dashboards/1/data': data,
      'GET /api/tags': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
      'DELETE /api/widgets/1': { status: 204 },
    });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderDashboard('/d/1');
    await screen.findByText('Widget 1');
    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(calls).not.toContain('DELETE /api/widgets/1');

    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(calls).toContain('DELETE /api/widgets/1');
    });
  });

  it('refreshes one widget without refetching the dashboard', async () => {
    const { calls } = stubApi({
      'GET /api/dashboards': DASHBOARDS,
      'GET /api/dashboards/1': structure,
      'GET /api/dashboards/1/data': data,
      'GET /api/tags': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
      'POST /api/widgets/1/data': {
        body: {
          widgets: { '1': feedData([makeItem()]) },
          generatedAt: '2026-07-30T12:05:00.000Z',
        },
      },
    });

    renderDashboard('/d/1');
    await screen.findByText('Widget 1');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh this widget' }));

    expect(await screen.findByText('Announcing AOS 7.2')).toBeDefined();
    // One widget refreshed means one widget fetched, not the whole dashboard.
    expect(calls.filter((call) => call.includes('/dashboards/1/data'))).toHaveLength(1);
  });
});
