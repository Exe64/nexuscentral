/**
 * The two bars: the application bar that never changes, and the page bar that does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Layout } from '../src/components/Layout.tsx';
import { PageBar, pageTitle } from '../src/components/PageBar.tsx';
import { Sources } from '../src/pages/Sources.tsx';
import { HEALTH_OK, renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SHELL = {
  'GET /api/tags': { body: { data: [] } },
  'GET /api/sources': { body: { data: [] } },
  'GET /api/dashboards': { body: { data: [] } },
  'GET /api/health': HEALTH_OK,
  'GET /api/items': { body: { data: [], nextCursor: null } },
  'GET /api/rules': { body: { data: [] } },
};

describe('the application bar', () => {
  it('carries the name and the global controls', async () => {
    stubApi(SHELL);
    renderPage(
      <Layout>
        <div />
      </Layout>,
      '/reader',
    );

    const bar = screen.getByRole('banner');
    expect(within(bar).getByText('Nexus Central')).toBeDefined();
    expect(within(bar).getByLabelText('Search')).toBeDefined();
    expect(within(bar).getByRole('button', { name: 'Refresh' })).toBeDefined();
    expect(within(bar).getByRole('button', { name: 'Keyboard shortcuts' })).toBeDefined();
    // The theme button names the mode it is in, not just an icon.
    expect(within(bar).getByRole('button', { name: /theme/i })).toBeDefined();
  });

  it('makes the name a link home, which is what people try first', () => {
    stubApi(SHELL);
    renderPage(
      <Layout>
        <div />
      </Layout>,
      '/settings',
    );

    expect(screen.getByRole('link', { name: 'Nexus Central' }).getAttribute('href')).toBe('/');
  });

  it('does not repeat the name in the sidebar', () => {
    // It used to be in both. Two copies of a brand is not branding.
    stubApi(SHELL);
    renderPage(
      <Layout>
        <div />
      </Layout>,
      '/reader',
    );

    expect(screen.getAllByText('Nexus Central')).toHaveLength(1);
  });
});

describe('the page bar', () => {
  it('names the current page', () => {
    stubApi(SHELL);
    renderPage(
      <Layout>
        <div />
      </Layout>,
      '/tags',
    );

    expect(screen.getByRole('heading', { name: 'Tags' })).toBeDefined();
  });

  it('is the only place the page name appears', async () => {
    // The four pages that printed their own heading no longer do; the bar is the
    // single source. Two headings saying "Sources" is an oversight, not a design.
    stubApi(SHELL);
    renderPage(
      <Layout>
        <Sources />
      </Layout>,
      '/sources',
    );

    await screen.findByText(/Paste a feed URL/);
    expect(screen.getAllByRole('heading', { name: 'Sources' })).toHaveLength(1);
  });

  it('renders nothing but the name when there is no dashboard yet', () => {
    stubApi(SHELL);
    renderPage(<PageBar />, '/reader');
    expect(screen.getByRole('heading', { name: 'Reader' })).toBeDefined();
  });
});

describe('pageTitle', () => {
  const t = ((key: string) => {
    const map: Record<string, string> = {
      'reader.title': 'Reader',
      'sources.title': 'Sources',
      'pagebar.dashboard': 'Dashboard',
    };
    return map[key] ?? key;
  }) as never;

  it('prefers a dashboard name over a generic label', () => {
    // "Home" and "Security" are the whole point of having several; a bar that
    // said "Dashboard" for both would be worse than the top bar it replaced.
    expect(pageTitle('/', 'Home', t)).toBe('Home');
    expect(pageTitle('/d/2', 'Security', t)).toBe('Security');
  });

  it('falls back to a label rather than an empty bar while the list loads', () => {
    expect(pageTitle('/d/2', undefined, t)).toBe('Dashboard');
  });

  it('uses the route name for every other page, ignoring any dashboard name', () => {
    expect(pageTitle('/sources', 'Home', t)).toBe('Sources');
  });
});
