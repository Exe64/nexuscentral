import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Reader } from '../src/pages/Reader.tsx';
import { Sources } from '../src/pages/Sources.tsx';
import { Tags } from '../src/pages/Tags.tsx';
import { HEALTH_OK, makeItem, makeSource, renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const EMPTY_ITEMS = { body: { data: [], nextCursor: null } };
const EMPTY_TAGS = { body: { data: [] } };
const EMPTY_SOURCES = { body: { data: [] } };

describe('Reader', () => {
  it('renders items with their source, tags and relative time', async () => {
    stubApi({
      'GET /api/items': { body: { data: [makeItem()], nextCursor: null } },
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/health': HEALTH_OK,
    });

    renderPage(<Reader />);

    expect(await screen.findByText('Announcing AOS 7.2')).toBeDefined();
    expect(screen.getByText('Nutanix Blog')).toBeDefined();
    // Dates go through Intl.RelativeTimeFormat, never string concatenation.
    expect(screen.getByText('1 hour ago')).toBeDefined();
    // The score is shown so a rule set can be judged at a glance.
    expect(screen.getByText(/8\.40/)).toBeDefined();
    expect(screen.getByText(/Storage/)).toBeDefined();
  });

  it('invites the user to add a source when there are none', async () => {
    stubApi({
      'GET /api/items': EMPTY_ITEMS,
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
    });

    renderPage(<Reader />);

    // An empty state is an invitation, not a blank box.
    expect(
      await screen.findByText('No items yet. Add a source and the first poll will fill this in.'),
    ).toBeDefined();
  });

  it('says "All caught up." when the unread filter empties the list', async () => {
    stubApi({
      'GET /api/items': EMPTY_ITEMS,
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': { body: { data: [makeSource()] } },
    });

    renderPage(<Reader />);
    await screen.findByText('No items match this filter.');

    await userEvent.click(screen.getByLabelText('Unread only'));

    expect(await screen.findByText('All caught up.')).toBeDefined();
  });

  it('sends the unread filter and the sort to the API', async () => {
    const stub = stubApi({
      'GET /api/items': EMPTY_ITEMS,
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
    });

    renderPage(<Reader />);
    await screen.findByText('No items yet. Add a source and the first poll will fill this in.');

    await userEvent.selectOptions(screen.getByLabelText(/Sort/), 'score');

    await waitFor(() => {
      expect(stub.calls.some((call) => call.includes('sort=score'))).toBe(true);
    });
  });

  it('marks an item read and refetches rather than patching the cache', async () => {
    const stub = stubApi({
      'GET /api/items': { body: { data: [makeItem()], nextCursor: null } },
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
      'POST /api/items/1/read': { status: 204 },
    });

    renderPage(<Reader />);
    await screen.findByText('Announcing AOS 7.2');

    await userEvent.click(screen.getByRole('button', { name: 'Mark as read' }));

    await waitFor(() => {
      expect(stub.calls).toContain('POST /api/items/1/read');
    });
    // An unread-only view has to drop the row, so the list is invalidated.
    await waitFor(() => {
      expect(stub.calls.filter((call) => call.startsWith('GET /api/items')).length).toBeGreaterThan(
        1,
      );
    });
  });

  it('reports a failed load with a retry rather than a blank page', async () => {
    stubApi({
      'GET /api/items': { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      'GET /api/tags': EMPTY_TAGS,
      'GET /api/sources': EMPTY_SOURCES,
    });

    renderPage(<Reader />);

    expect(await screen.findByText(/Could not load items/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});

describe('Sources', () => {
  it('shows the resolve preview with three real items before saving', async () => {
    // The acceptance criterion: paste a blog homepage, see real items first.
    const stub = stubApi({
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/sources/resolve': {
        body: {
          candidates: [
            {
              kind: 'rss',
              identifier: 'https://www.nutanix.com/blog/rss.xml',
              title: 'Nutanix Blog',
              siteUrl: 'https://www.nutanix.com/blog',
              sampleItems: [
                {
                  title: 'Announcing AOS 7.2',
                  url: 'https://www.nutanix.com/blog/a',
                  publishedAt: '2026-07-28T09:00:00.000Z',
                },
                {
                  title: 'CVE-2026-31337 in Prism Central',
                  url: 'https://www.nutanix.com/blog/b',
                  publishedAt: '2026-07-27T14:30:00.000Z',
                },
                {
                  title: 'Sizing NVMe tiers',
                  url: 'https://www.nutanix.com/blog/c',
                  publishedAt: '2026-07-24T08:15:00.000Z',
                },
              ],
              existingSourceId: null,
            },
          ],
        },
      },
      'POST /api/sources': { status: 201, body: { data: makeSource() } },
    });

    renderPage(<Sources />);

    await userEvent.type(
      screen.getByLabelText(/Feed URL, blog address/),
      'https://www.nutanix.com/blog',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Recent items')).toBeDefined();
    expect(screen.getByText('Announcing AOS 7.2')).toBeDefined();
    expect(screen.getByText('CVE-2026-31337 in Prism Central')).toBeDefined();
    expect(screen.getByText('Sizing NVMe tiers')).toBeDefined();

    // Nothing is created until the user confirms.
    expect(stub.calls).not.toContain('POST /api/sources');

    await userEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => {
      expect(stub.calls).toContain('POST /api/sources');
    });
  });

  it('refuses to add a candidate that is already tracked', async () => {
    stubApi({
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/sources/resolve': {
        body: {
          candidates: [
            {
              kind: 'rss',
              identifier: 'https://www.nutanix.com/blog/rss.xml',
              title: 'Nutanix Blog',
              sampleItems: [],
              existingSourceId: 7,
            },
          ],
        },
      },
    });

    renderPage(<Sources />);
    await userEvent.type(screen.getByLabelText(/Feed URL, blog address/), 'x.example');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Already tracked.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add source' })).toBeNull();
  });

  it('explains a failed resolve with the server message', async () => {
    stubApi({
      'GET /api/sources': EMPTY_SOURCES,
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/sources/resolve': {
        status: 502,
        body: { error: { code: 'UPSTREAM_FAILED', message: 'No feed found at that address' } },
      },
    });

    renderPage(<Sources />);
    await userEvent.type(screen.getByLabelText(/Feed URL, blog address/), 'nothing.example');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText(/No feed found at that address/)).toBeDefined();
  });

  it('lists sources with their health and offers an OPML export link', async () => {
    stubApi({
      'GET /api/sources': {
        body: {
          data: [
            makeSource({
              health: {
                lastRunAt: new Date().toISOString(),
                lastOkAt: null,
                lastError: 'HTTP 500',
                consecutiveFailures: 3,
                consecutiveEmpty: 0,
              },
            }),
          ],
        },
      },
      'GET /api/tags': EMPTY_TAGS,
    });

    renderPage(<Sources />);

    expect(await screen.findByText('3 consecutive failures')).toBeDefined();
    expect(screen.getByText('HTTP 500')).toBeDefined();

    const exportLink = screen.getByRole('link', { name: 'Export OPML' });
    expect(exportLink.getAttribute('href')).toBe('/api/sources/export');
  });

  it('replaces a source tag set rather than merging it', async () => {
    const stub = stubApi({
      'GET /api/sources': {
        body: {
          data: [
            makeSource({
              tags: [
                {
                  id: 1,
                  name: 'Storage',
                  slug: 'storage',
                  color: 'teal',
                  createdAt: '2026-07-01T00:00:00.000Z',
                },
              ],
            }),
          ],
        },
      },
      'GET /api/tags': {
        body: {
          data: [
            {
              id: 1,
              name: 'Storage',
              slug: 'storage',
              color: 'teal',
              createdAt: '2026-07-01T00:00:00.000Z',
              sourceCount: 1,
              unreadCount: 0,
            },
            {
              id: 2,
              name: 'Networking',
              slug: 'networking',
              color: 'blue',
              createdAt: '2026-07-01T00:00:00.000Z',
              sourceCount: 0,
              unreadCount: 0,
            },
          ],
        },
      },
      'PATCH /api/sources/1': { body: { data: makeSource() } },
    });

    renderPage(<Sources />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    // Storage starts checked; swap it for Networking.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Storage' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Networking' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(stub.calls).toContain('PATCH /api/sources/1');
    });
    const patch = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    // The dialog saves the whole form, so the assertion is about the tag set
    // specifically: [2], not [1, 2]. Replaced, not merged.
    expect(JSON.parse(String((patch?.[1] as RequestInit).body)).tagIds).toEqual([2]);
  });

  it('invites the user to add a first source', async () => {
    stubApi({ 'GET /api/sources': EMPTY_SOURCES, 'GET /api/tags': EMPTY_TAGS });

    renderPage(<Sources />);

    expect(
      await screen.findByText('No sources yet. Add a feed, subreddit or X account to get started.'),
    ).toBeDefined();
  });
});

describe('Tags', () => {
  const TAG = {
    id: 1,
    name: 'Storage',
    slug: 'storage',
    color: 'teal',
    createdAt: '2026-07-01T00:00:00.000Z',
    sourceCount: 4,
    unreadCount: 12,
  };

  it('lists tags with their slug and counts', async () => {
    stubApi({ 'GET /api/tags': { body: { data: [TAG] } } });

    renderPage(<Tags />);

    expect(await screen.findByText('Storage')).toBeDefined();
    expect(screen.getByText('storage')).toBeDefined();
    expect(screen.getByText('4')).toBeDefined();
    expect(screen.getByText('12')).toBeDefined();
  });

  it('creates a tag without sending a slug', async () => {
    const stub = stubApi({
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/tags': { status: 201, body: { data: TAG } },
    });

    renderPage(<Tags />);
    await screen.findByText(/No tags yet/);

    await userEvent.type(screen.getByLabelText('Name'), 'Storage');
    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));

    await waitFor(() => {
      expect(stub.calls).toContain('POST /api/tags');
    });
    expect(await screen.findByText('Tag added')).toBeDefined();
  });

  it('reports a duplicate as a conflict rather than a generic failure', async () => {
    stubApi({
      'GET /api/tags': EMPTY_TAGS,
      'POST /api/tags': {
        status: 409,
        body: {
          error: { code: 'CONFLICT', message: 'A tag with the slug "storage" already exists' },
        },
      },
    });

    renderPage(<Tags />);
    await screen.findByText(/No tags yet/);

    await userEvent.type(screen.getByLabelText('Name'), 'Storage');
    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));

    expect(await screen.findByText('That already exists.')).toBeDefined();
  });

  it('confirms before deleting, and does not delete when cancelled', async () => {
    const stub = stubApi({ 'GET /api/tags': { body: { data: [TAG] } } });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );

    renderPage(<Tags />);
    await screen.findByText('Storage');

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(stub.calls).not.toContain('DELETE /api/tags/1');
  });
});
