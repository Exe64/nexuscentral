/**
 * Source icons: where they show, and where they deliberately do not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Reader } from '../src/pages/Reader.tsx';
import { HEALTH_OK, makeItem, makeSettings, renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ICON = 'https://cdn.example.com/icon.png';
const IMAGE = 'https://cdn.example.com/hero.jpg';

function withSource(readerView: string, item: Record<string, unknown>) {
  const base = makeItem();
  return stubApi({
    'GET /api/items': {
      body: {
        data: [
          {
            ...base,
            ...item,
            source: { ...(base['source'] as object), iconUrl: ICON },
          },
        ],
        nextCursor: null,
      },
    },
    'GET /api/tags': { body: { data: [] } },
    'GET /api/sources': { body: { data: [] } },
    'GET /api/health': HEALTH_OK,
    'GET /api/settings': { body: { data: makeSettings({ readerView }) } },
  });
}

describe('source icons', () => {
  it.each(['list', 'cards', 'titles'])('appears beside the source name in %s', async (view) => {
    withSource(view, { imageUrl: null });
    renderPage(<Reader />);
    await screen.findByText('Announcing AOS 7.2');

    expect(document.querySelector(`img[src="${ICON}"]`)).not.toBeNull();
  });

  it('fills a card with no article image, so the list still lines up', async () => {
    withSource('cards', { imageUrl: null });
    renderPage(<Reader />);
    await screen.findByText('Announcing AOS 7.2');

    // Two: one in the meta line, one standing in for the missing preview.
    expect(document.querySelectorAll(`img[src="${ICON}"]`)).toHaveLength(2);
  });

  it('does not stand in when the article has a real preview', async () => {
    // The point of the fallback is the empty box, not replacing a thumbnail.
    withSource('cards', { imageUrl: IMAGE });
    renderPage(<Reader />);
    await screen.findByText('Announcing AOS 7.2');

    expect(document.querySelector(`img[src="${IMAGE}"]`)).not.toBeNull();
    expect(document.querySelectorAll(`img[src="${ICON}"]`)).toHaveLength(1);
  });

  it('is decorative and sends no referer', async () => {
    withSource('list', { imageUrl: null });
    renderPage(<Reader />);
    await screen.findByText('Announcing AOS 7.2');

    const icon = document.querySelector(`img[src="${ICON}"]`);
    expect(icon?.getAttribute('alt')).toBe('');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('referrerpolicy')).toBe('no-referrer');
    // `contain`, not `cover`: cropping a wordmark to a square loses its ends.
    expect(icon?.getAttribute('class')).toContain('object-contain');
  });

  it('renders nothing at all when the source has no icon', async () => {
    // A guessed /favicon.ico is often a 404, so this is the common case.
    stubApi({
      'GET /api/items': { body: { data: [makeItem({ imageUrl: null })], nextCursor: null } },
      'GET /api/tags': { body: { data: [] } },
      'GET /api/sources': { body: { data: [] } },
      'GET /api/health': HEALTH_OK,
      'GET /api/settings': { body: { data: makeSettings({ readerView: 'cards' }) } },
    });
    renderPage(<Reader />);
    await screen.findByText('Announcing AOS 7.2');

    expect(document.querySelector('img')).toBeNull();
  });
});
