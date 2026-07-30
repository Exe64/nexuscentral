/**
 * The shell and its keyboard shortcuts (04-SPEC-frontend.md 2).
 *
 * The acceptance criterion is full keyboard navigation of the reader with visible
 * focus throughout, so these drive the real components with real key events rather
 * than calling handlers directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Reader } from '../src/pages/Reader.tsx';
import { Layout } from '../src/components/Layout.tsx';
import { useUiStore } from '../src/stores/ui.ts';
import { useThemeStore } from '../src/theme/store.ts';
import { HEALTH_OK, makeItem, renderPage, stubApi } from './helpers.tsx';

const EMPTY_TAGS = { body: { data: [] } };
const EMPTY_SOURCES = { body: { data: [] } };

function items(count: number): Record<string, unknown> {
  return {
    body: {
      data: Array.from({ length: count }, (_unused, index) =>
        makeItem({
          id: String(index + 1),
          title: `Item ${index + 1}`,
          url: `https://x/${index + 1}`,
        }),
      ),
      nextCursor: null,
    },
  };
}

beforeEach(() => {
  localStorage.clear();

  // The whole store, counters included. Leaving `searchFocusRequests` at 1 from a
  // previous test made the next top bar focus its search box on mount, after which
  // every key event landed in an input and the "never fire while typing" guard
  // correctly refused to run -- for entirely the wrong reason.
  useUiStore.setState({
    search: '',
    sidebarOpen: false,
    shortcutsOpen: false,
    searchFocusRequests: 0,
    refreshRequests: 0,
  });

  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reader keyboard navigation', () => {
  it('moves the focused item with j and k', async () => {
    stubApi({
      'GET /api/items': items(3),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
    });

    renderPage(<Reader />);
    await screen.findByText('Item 1');

    const rows = screen.getAllByRole('listitem');
    // The first row starts focusable; the rest are removed from the tab order so
    // Tab does not have to walk fifty items to reach the pagination button.
    expect(rows[0]?.getAttribute('tabindex')).toBe('0');
    expect(rows[1]?.getAttribute('tabindex')).toBe('-1');

    await userEvent.keyboard('j');
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('listitem')[1]));

    await userEvent.keyboard('j');
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('listitem')[2]));

    await userEvent.keyboard('k');
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('listitem')[1]));
  });

  it('stops at the ends rather than wrapping', async () => {
    stubApi({
      'GET /api/items': items(2),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
    });

    renderPage(<Reader />);
    await screen.findByText('Item 1');

    // Wrapping from the last item to the first is disorienting in a list you are
    // working through top to bottom.
    await userEvent.keyboard('jjjj');
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('listitem')[1]));

    await userEvent.keyboard('kkkk');
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('listitem')[0]));
  });

  it('marks the focused item read with m and stars it with s', async () => {
    const stub = stubApi({
      'GET /api/items': items(2),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'POST /api/items/2/read': { status: 204 },
      'POST /api/items/2/star': { status: 204 },
    });

    renderPage(<Reader />);
    await screen.findByText('Item 1');

    await userEvent.keyboard('j');
    await userEvent.keyboard('m');
    await waitFor(() => expect(stub.calls).toContain('POST /api/items/2/read'));

    await userEvent.keyboard('s');
    await waitFor(() => expect(stub.calls).toContain('POST /api/items/2/star'));
  });

  it('opens the focused item with o and marks it read', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);

    const stub = stubApi({
      'GET /api/items': items(2),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'POST /api/items/1/read': { status: 204 },
    });

    renderPage(<Reader />);
    await screen.findByText('Item 1');

    await userEvent.keyboard('o');

    expect(open).toHaveBeenCalledWith('https://x/1', '_blank', 'noreferrer,noopener');
    await waitFor(() => expect(stub.calls).toContain('POST /api/items/1/read'));
  });

  it('does not fire shortcuts while the user is typing', async () => {
    const stub = stubApi({
      'GET /api/items': items(2),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
    });

    renderPage(
      <Layout>
        <Reader />
      </Layout>,
    );
    await screen.findByText('Item 1');

    const search = screen.getByLabelText('Search');
    await userEvent.click(search);
    // A "j" in a search box is a letter, not a navigation command.
    await userEvent.type(search, 'jjjs/');

    expect((search as HTMLInputElement).value).toBe('jjjs/');
    expect(stub.calls.some((call) => call.includes('/star'))).toBe(false);
  });
});

describe('global shortcuts', () => {
  it('focuses the search box on /', async () => {
    stubApi({
      'GET /api/items': items(1),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/health': HEALTH_OK,
    });

    renderPage(
      <Layout>
        <Reader />
      </Layout>,
    );
    await screen.findByText('Item 1');

    await userEvent.keyboard('/');

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Search')));
  });

  it('opens and closes the shortcut overlay with ? and Escape', async () => {
    stubApi({
      'GET /api/items': items(1),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/health': HEALTH_OK,
    });

    renderPage(
      <Layout>
        <Reader />
      </Layout>,
    );

    await userEvent.keyboard('?');
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeDefined();
    // The list has to name the keys, or it is not documentation.
    expect(screen.getByText('Next item')).toBeDefined();

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull(),
    );
  });

  it('cycles the theme with t', async () => {
    stubApi({
      'GET /api/items': items(1),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/health': HEALTH_OK,
    });

    useThemeStore.getState().setMode('system');

    renderPage(
      <Layout>
        <Reader />
      </Layout>,
    );

    await userEvent.keyboard('t');
    expect(useThemeStore.getState().mode).toBe('light');
    await userEvent.keyboard('t');
    expect(useThemeStore.getState().mode).toBe('dark');
    await userEvent.keyboard('t');
    expect(useThemeStore.getState().mode).toBe('system');
  });

  it('leaves browser chords alone', async () => {
    stubApi({
      'GET /api/items': items(1),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/health': HEALTH_OK,
    });

    renderPage(
      <Layout>
        <Reader />
      </Layout>,
    );

    // Ctrl+R must still reload the page rather than refetching the list.
    await userEvent.keyboard('{Control>}r{/Control}');
    expect(useUiStore.getState().refreshRequests).toBe(0);
  });
});

describe('the shell', () => {
  it('offers a skip link before the navigation', async () => {
    stubApi({
      'GET /api/items': items(1),
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/health': HEALTH_OK,
    });

    renderPage(
      <Layout>
        <Reader />
      </Layout>,
    );

    const skip = await screen.findByText('Skip to content');
    expect(skip.getAttribute('href')).toBe('#main');
  });

  it('lists tags with their unread counts', async () => {
    stubApi({
      'GET /api/items': items(1),
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/health': HEALTH_OK,
      'GET /api/tags': {
        body: {
          data: [
            {
              id: 1,
              name: 'Storage',
              slug: 'storage',
              color: 'teal',
              createdAt: '2026-07-01T00:00:00.000Z',
              sourceCount: 4,
              unreadCount: 12,
            },
          ],
        },
      },
    });

    renderPage(
      <Layout>
        <Reader />
      </Layout>,
    );

    // Item rows show their source's tags too, so scope the query to the sidebar.
    // The sidebar renders before the tag query settles, so this has to wait.
    const sidebar = await screen.findByRole('complementary', { name: 'Main navigation' });
    expect(await within(sidebar).findByText('Storage')).toBeDefined();
    expect(within(sidebar).getByText('12')).toBeDefined();
  });
});
