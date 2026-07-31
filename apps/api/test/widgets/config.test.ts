/**
 * The shared widget config contract.
 *
 * Lives here rather than in `packages/shared` because the shared package has no
 * test runner of its own and these are the rules the API enforces at its boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_WIDGET_TYPES,
  WIDGET_CONFIG_SCHEMAS,
  WIDGET_GEOMETRY,
  WIDGET_TYPES,
  defaultWidgetConfig,
  parseWidgetConfig,
} from '@nexuscentral/shared';
import { WIDGET_RESOLVERS } from '../../src/widgets/resolvers.js';

describe('widget config schemas', () => {
  it('covers every widget type', () => {
    expect(Object.keys(WIDGET_CONFIG_SCHEMAS).sort()).toEqual([...WIDGET_TYPES].sort());
  });

  it('produces a usable config from nothing at all', () => {
    for (const type of AVAILABLE_WIDGET_TYPES) {
      expect(() => defaultWidgetConfig(type)).not.toThrow();
    }
  });

  it('rejects a limit outside the range rather than clamping it silently', () => {
    expect(() => parseWidgetConfig('feed', { limit: 0 })).toThrow();
    expect(() => parseWidgetConfig('feed', { limit: 51 })).toThrow();
    expect(parseWidgetConfig('feed', { limit: 50 })['limit']).toBe(50);
  });

  it('treats collapseAfter as nullable, because "off" is a real setting', () => {
    expect(parseWidgetConfig('feed', { collapseAfter: null })['collapseAfter']).toBeNull();
    expect(parseWidgetConfig('feed', { collapseAfter: 5 })['collapseAfter']).toBe(5);
  });

  it('defaults source health to hiding healthy sources', () => {
    // "All sources healthy." is the useful state, not a list of forty green rows.
    expect(defaultWidgetConfig('source_health')['showHealthy']).toBe(false);
  });

  it('caps the tag filter so one config cannot build an unbounded query', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(() => parseWidgetConfig('feed', { tagIds: tooMany })).toThrow();
  });
});

describe('widget geometry', () => {
  it('covers every widget type', () => {
    expect(Object.keys(WIDGET_GEOMETRY).sort()).toEqual([...WIDGET_TYPES].sort());
  });

  it('never sets a minimum larger than the default', () => {
    for (const [type, geometry] of Object.entries(WIDGET_GEOMETRY)) {
      expect(geometry.minSize.w, type).toBeLessThanOrEqual(geometry.defaultSize.w);
      expect(geometry.minSize.h, type).toBeLessThanOrEqual(geometry.defaultSize.h);
    }
  });

  it('fits every default inside the 12-column large grid', () => {
    for (const [type, geometry] of Object.entries(WIDGET_GEOMETRY)) {
      expect(geometry.defaultSize.w, type).toBeLessThanOrEqual(12);
    }
  });
});

describe('the registries agree', () => {
  it('has a resolver for every type, so a payload is never undefined', () => {
    expect(Object.keys(WIDGET_RESOLVERS).sort()).toEqual([...WIDGET_TYPES].sort());
  });

  it('offers every type except custom_api, which lands in Phase 6', () => {
    expect([...AVAILABLE_WIDGET_TYPES].sort()).toEqual(
      WIDGET_TYPES.filter((type) => type !== 'custom_api').sort(),
    );
  });

  it('rejects a custom_api widget rather than returning an empty payload', async () => {
    await expect(
      WIDGET_RESOLVERS.custom_api({
        id: 1,
        dashboardId: 1,
        type: 'custom_api',
        title: 'Weather',
        config: { url: 'https://example.com' },
        layout: {},
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toThrow();
  });
});
