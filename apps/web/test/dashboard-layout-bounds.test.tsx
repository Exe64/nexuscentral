/**
 * One unstorable entry must not cost the whole dashboard its layout.
 *
 * Reported from a live install as "widget size and position are not kept", and
 * the message the API returned was `Request validation failed`. The layout
 * endpoint validates an *array*: zod rejects the batch if any single element is
 * out of range, so one widget with an impossible height means nothing at all is
 * saved -- every other widget's position included.
 */

import { describe, expect, it } from 'vitest';
import type { Layouts } from 'react-grid-layout';
import { isStorable, layoutEntries } from '../src/components/DashboardGrid.tsx';

const ok = { widgetId: 1, breakpoint: 'lg' as const, x: 0, y: 0, w: 4, h: 8 };

describe('isStorable', () => {
  it('accepts an ordinary entry', () => {
    expect(isStorable(ok)).toBe(true);
  });

  it('applies the same bounds the API does', () => {
    expect(isStorable({ ...ok, h: 101 })).toBe(false);
    expect(isStorable({ ...ok, h: 100 })).toBe(true);
    expect(isStorable({ ...ok, y: 501 })).toBe(false);
    expect(isStorable({ ...ok, y: 500 })).toBe(true);
    expect(isStorable({ ...ok, x: 25 })).toBe(false);
    expect(isStorable({ ...ok, w: 0 })).toBe(false);
    expect(isStorable({ ...ok, x: -1 })).toBe(false);
  });

  it('rejects what is not a whole number', () => {
    // The endpoint takes integers. A fraction is refused rather than rounded:
    // guessing at what a caller meant is how a layout ends up half a column off.
    expect(isStorable({ ...ok, h: 8.5 })).toBe(false);
    expect(isStorable({ ...ok, w: Number.NaN })).toBe(false);
    expect(isStorable({ ...ok, y: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('rejects an id that is not one', () => {
    // `widgetId` comes from `Number(item.i)`, and `i` is whatever the library
    // was holding -- including, one day, something that is not a widget.
    expect(isStorable({ ...ok, widgetId: Number.NaN })).toBe(false);
    expect(isStorable({ ...ok, widgetId: 0 })).toBe(false);
  });
});

describe('layoutEntries', () => {
  it('keeps the good entries when one is unstorable', () => {
    const layouts: Layouts = {
      lg: [
        { i: '1', x: 0, y: 0, w: 4, h: 8 },
        // The one that would have taken the batch down with it.
        { i: '2', x: 0, y: 0, w: 4, h: 4000 },
        { i: '3', x: 8, y: 0, w: 4, h: 6 },
      ],
      md: [],
      sm: [],
      xs: [],
    };

    const entries = layoutEntries(layouts);

    expect(entries.map((entry) => entry.widgetId)).toEqual([1, 3]);
  });

  it('sends nothing rather than something invalid when every entry is bad', () => {
    const layouts: Layouts = {
      lg: [{ i: 'not-a-widget', x: 0, y: 0, w: 4, h: 8 }],
      md: [],
      sm: [],
      xs: [],
    };

    expect(layoutEntries(layouts)).toEqual([]);
  });
});
