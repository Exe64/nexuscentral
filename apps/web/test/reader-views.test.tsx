/**
 * The reader's three layouts, and the thumbnails one of them exists for.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Reader } from '../src/pages/Reader.tsx';
import { HEALTH_OK, makeItem, makeSettings, renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const IMAGE = 'https://cdn.example.com/hero.jpg';

function stub(readerView: string, itemOverrides: Record<string, unknown> = {}) {
  return stubApi({
    'GET /api/items': { body: { data: [makeItem(itemOverrides)], nextCursor: null } },
    'GET /api/tags': { body: { data: [] } },
    'GET /api/sources': { body: { data: [] } },
    'GET /api/health': HEALTH_OK,
    'GET /api/settings': { body: { data: makeSettings({ readerView }) } },
    'PATCH /api/settings': { body: { data: makeSettings({ readerView: 'cards' }) } },
  });
}

describe('reader layouts', () => {
  it('shows no thumbnail in list mode even when the item has one', async () => {
    stub('list', { imageUrl: IMAGE });
    renderPage(<Reader />);

    await screen.findByText('Announcing AOS 7.2');
    expect(document.querySelector(`img[src="${IMAGE}"]`)).toBeNull();
    // The summary is what list mode is for.
    expect(screen.getByText(/Erasure coding improvements/)).toBeDefined();
  });

  it('shows the thumbnail in cards mode', async () => {
    stub('cards', { imageUrl: IMAGE });
    renderPage(<Reader />);

    await screen.findByText('Announcing AOS 7.2');
    expect(document.querySelector(`img[src="${IMAGE}"]`)).not.toBeNull();
  });

  it('drops the summary and the action buttons in titles mode', async () => {
    // Density is the whole point of the mode; keeping the furniture would defeat it.
    stub('titles', { imageUrl: IMAGE });
    renderPage(<Reader />);

    await screen.findByText('Announcing AOS 7.2');
    expect(screen.queryByText(/Erasure coding improvements/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as read' })).toBeNull();
    expect(document.querySelector(`img[src="${IMAGE}"]`)).toBeNull();
  });

  it('leaves the layout usable for an item with no image', async () => {
    // Most items have none, so cards mode must not depend on one.
    stub('cards', { imageUrl: null });
    renderPage(<Reader />);

    expect(await screen.findByText('Announcing AOS 7.2')).toBeDefined();
    expect(document.querySelector('img')).toBeNull();
  });

  it('saves the choice rather than keeping it in component state', async () => {
    // A layout that resets on reload is not a preference, it is a toggle.
    const api = stub('list');
    renderPage(<Reader />);

    await screen.findByText('Announcing AOS 7.2');
    await userEvent.click(screen.getByRole('button', { name: 'Cards' }));

    await waitFor(() => {
      expect(api.calls).toContain('PATCH /api/settings');
    });
  });

  it('marks the active layout with aria-pressed, not just colour', async () => {
    stub('titles');
    renderPage(<Reader />);

    await screen.findByText('Announcing AOS 7.2');
    expect(screen.getByRole('button', { name: 'Titles' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('thumbnails', () => {
  it('is lazy, sends no referer, and is hidden from screen readers', async () => {
    // no-referrer is not decoration: preview.redd.it and several CDNs refuse a
    // request that names another site, and sending one leaks the reading history.
    stub('cards', { imageUrl: IMAGE });
    renderPage(<Reader />);

    await screen.findByText('Announcing AOS 7.2');
    const img = document.querySelector(`img[src="${IMAGE}"]`);

    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('aria-hidden')).toBe('true');
  });

  it('removes an image that fails rather than showing a broken icon', async () => {
    // Articles move and signed CDN URLs expire; this is the common case, not the
    // exotic one.
    stub('cards', { imageUrl: IMAGE });
    renderPage(<Reader />);

    await screen.findByText('Announcing AOS 7.2');
    const img = document.querySelector(`img[src="${IMAGE}"]`);
    expect(img).not.toBeNull();

    fireEvent.error(img as Element);

    await waitFor(() => {
      expect(document.querySelector(`img[src="${IMAGE}"]`)).toBeNull();
    });
    // The item itself survives its thumbnail.
    expect(screen.getByText('Announcing AOS 7.2')).toBeDefined();
  });
});
