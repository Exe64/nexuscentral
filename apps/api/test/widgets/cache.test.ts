/**
 * The per-widget payload cache (03-SPEC-api.md 6).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Widget } from '@nexuscentral/shared';
import {
  CACHE_TTL_MS,
  clearWidgetCache,
  invalidateWidget,
  throughCache,
  widgetCacheKey,
  widgetCacheStats,
} from '../../src/widgets/cache.js';

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: 1,
    dashboardId: 1,
    type: 'feed',
    title: 'Everything',
    config: { limit: 15 },
    layout: {},
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(clearWidgetCache);

describe('widgetCacheKey', () => {
  it('changes when the config changes', () => {
    const before = widgetCacheKey(makeWidget(), 'never');
    const after = widgetCacheKey(makeWidget({ config: { limit: 5 } }), 'never');
    expect(after).not.toBe(before);
  });

  it('changes when an item is ingested', () => {
    const before = widgetCacheKey(makeWidget(), 'never');
    const after = widgetCacheKey(makeWidget(), '2026-07-30T12:00:00.000Z');
    // A poll that inserts something must make new items appear, not wait out a TTL.
    expect(after).not.toBe(before);
  });

  it('is stable for the same widget and the same ingestion state', () => {
    expect(widgetCacheKey(makeWidget(), 'never')).toBe(widgetCacheKey(makeWidget(), 'never'));
  });

  it('separates two widgets that happen to share a config', () => {
    const first = widgetCacheKey(makeWidget({ id: 1 }), 'never');
    const second = widgetCacheKey(makeWidget({ id: 2 }), 'never');
    expect(second).not.toBe(first);
  });
});

describe('throughCache', () => {
  it('resolves once and serves the rest from memory', async () => {
    const resolve = vi.fn().mockResolvedValue({ items: [] });

    await throughCache('k', resolve);
    await throughCache('k', resolve);
    await throughCache('k', resolve);

    expect(resolve).toHaveBeenCalledOnce();
    expect(widgetCacheStats()).toMatchObject({ hits: 2, misses: 1 });
  });

  it('resolves again once the entry expires', async () => {
    const resolve = vi.fn().mockResolvedValue({ items: [] });

    await throughCache('k', resolve, 0);
    await throughCache('k', resolve, CACHE_TTL_MS - 1);
    await throughCache('k', resolve, CACHE_TTL_MS + 1);

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('never caches a rejection', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('database went away'));

    await expect(throughCache('k', resolve)).rejects.toThrow('database went away');
    await expect(throughCache('k', resolve)).rejects.toThrow('database went away');

    // A transient failure must not stick around for a minute pretending to be an
    // answer.
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(widgetCacheStats().size).toBe(0);
  });

  it('evicts rather than growing without limit', async () => {
    for (let i = 0; i < 250; i += 1) {
      await throughCache(`key-${i}`, () => Promise.resolve(i));
    }
    expect(widgetCacheStats().size).toBeLessThanOrEqual(200);
  });

  it('drops everything when a widget is invalidated', async () => {
    await throughCache('k', () => Promise.resolve(1));
    invalidateWidget(1);

    // The key is a hash, so the widget id cannot be recovered from it; clearing
    // everything is correct and costs one recomputation.
    expect(widgetCacheStats().size).toBe(0);
  });
});
