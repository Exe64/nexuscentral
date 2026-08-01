/**
 * Filtering a feed widget by source, alongside the tag filter it already had.
 */

import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultWidgetConfig, type Source } from '@nexuscentral/shared';
import { FeedConfigForm, matchingSources } from '../src/widgets/FeedWidget.tsx';
import { makeSource, renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STORAGE = {
  id: 1,
  name: 'Storage',
  slug: 'storage',
  color: 'teal',
  createdAt: '2026-07-01T00:00:00.000Z',
};

function source(id: number, title: string, overrides: Record<string, unknown> = {}) {
  return makeSource({
    id,
    title,
    identifier: `https://${title.toLowerCase()}.example/feed`,
    ...overrides,
  });
}

function stub(sources: Record<string, unknown>[]) {
  return stubApi({
    'GET /api/sources': { body: { data: sources } },
    'GET /api/tags': { body: { data: [{ ...STORAGE, sourceCount: 1, unreadCount: 0 }] } },
  });
}

function Harness({
  initial = {},
  onConfig = (): void => {},
}: {
  initial?: Record<string, unknown>;
  onConfig?: (config: Record<string, unknown>) => void;
}): ReactNode {
  const [config, setConfig] = useState<Record<string, unknown>>({
    ...defaultWidgetConfig('feed'),
    ...initial,
  });
  return (
    <FeedConfigForm
      value={config}
      onChange={(next) => {
        setConfig(next);
        onConfig(next);
      }}
    />
  );
}

describe('matchingSources', () => {
  const sources = [
    makeSource({ id: 1, tags: [STORAGE] }),
    makeSource({ id: 2, tags: [] }),
    makeSource({ id: 3, tags: [STORAGE] }),
  ] as unknown as Source[];

  it('is every source when neither filter is set', () => {
    expect(matchingSources(sources, [], [])).toHaveLength(3);
  });

  it('takes any of the tags, not all of them', () => {
    expect(matchingSources(sources, [STORAGE.id], []).map((s) => s.id)).toEqual([1, 3]);
  });

  it('intersects the two filters rather than adding them', () => {
    // Source 2 carries no tag, so tag+source is empty even though each filter on
    // its own selects something. This is the combination that quietly produces a
    // widget with nothing in it.
    expect(matchingSources(sources, [STORAGE.id], [2])).toEqual([]);
    expect(matchingSources(sources, [STORAGE.id], [1, 2])).toHaveLength(1);
  });

  it('drops an id whose source no longer exists', () => {
    expect(matchingSources(sources, [], [99])).toEqual([]);
  });
});

describe('the source filter in the feed config form', () => {
  it('records the sources that are ticked', async () => {
    stub([source(1, 'Nutanix'), source(2, 'Phoronix')]);
    const onConfig = vi.fn();
    renderPage(<Harness onConfig={onConfig} />);

    await userEvent.click(await screen.findByLabelText('Phoronix'));

    expect(onConfig).toHaveBeenLastCalledWith(expect.objectContaining({ sourceIds: [2] }));
  });

  it('unticks without disturbing the other selections', async () => {
    stub([source(1, 'Nutanix'), source(2, 'Phoronix')]);
    const onConfig = vi.fn();
    renderPage(<Harness initial={{ sourceIds: [1, 2] }} onConfig={onConfig} />);

    await userEvent.click(await screen.findByLabelText('Nutanix'));

    expect(onConfig).toHaveBeenLastCalledWith(expect.objectContaining({ sourceIds: [2] }));
  });

  it('says how many sources the widget will draw from', async () => {
    stub([source(1, 'Nutanix'), source(2, 'Phoronix'), source(3, 'LWN')]);
    renderPage(<Harness initial={{ sourceIds: [1, 3] }} />);

    expect(await screen.findByText('Draws from 2 of 3 sources.')).toBeTruthy();
  });

  it('warns when the tag and the source filters do not intersect', async () => {
    stub([source(1, 'Nutanix', { tags: [STORAGE] }), source(2, 'Phoronix')]);
    renderPage(<Harness initial={{ tagIds: [STORAGE.id], sourceIds: [2] }} />);

    expect(await screen.findByText(/this widget will stay empty/)).toBeTruthy();
  });

  it('leaves the count alone when only tags are set', async () => {
    stub([source(1, 'Nutanix', { tags: [STORAGE] }), source(2, 'Phoronix')]);
    renderPage(<Harness initial={{ tagIds: [STORAGE.id] }} />);

    expect(await screen.findByText('Draws from 1 of 2 sources.')).toBeTruthy();
  });
});

describe('searching the source list', () => {
  const many = Array.from({ length: 10 }, (_, index) => source(index + 1, `Source${index + 1}`));

  it('has no search box for a list that already fits', async () => {
    stub([source(1, 'Nutanix'), source(2, 'Phoronix')]);
    renderPage(<Harness />);

    expect(await screen.findByLabelText('Nutanix')).toBeTruthy();
    expect(screen.queryByLabelText('Filter sources')).toBeNull();
  });

  it('narrows the list to what matches', async () => {
    stub(many);
    renderPage(<Harness />);

    await userEvent.type(await screen.findByLabelText('Filter sources'), 'Source1');

    // `Source1` and `Source10`, not the eight others.
    expect(screen.getByLabelText('Source1')).toBeTruthy();
    expect(screen.getByLabelText('Source10')).toBeTruthy();
    expect(screen.queryByLabelText('Source2')).toBeNull();
  });

  it('matches the identifier as well as the title', async () => {
    stub([...many.slice(0, 9), source(99, 'Renamed', { identifier: 'https://lwn.net/headlines' })]);
    renderPage(<Harness />);

    await userEvent.type(await screen.findByLabelText('Filter sources'), 'lwn.net');

    expect(screen.getByLabelText('Renamed')).toBeTruthy();
    expect(screen.queryByLabelText('Source1')).toBeNull();
  });

  it('keeps a ticked source on screen when the search excludes it', async () => {
    stub(many);
    renderPage(<Harness initial={{ sourceIds: [2] }} />);

    await userEvent.type(await screen.findByLabelText('Filter sources'), 'Source5');

    // Otherwise you filter, tick, filter again, and what you picked is neither
    // reviewable nor removable without reconstructing the search that found it.
    expect(screen.getByLabelText('Source2')).toBeTruthy();
    expect((screen.getByLabelText('Source2') as HTMLInputElement).checked).toBe(true);
  });

  it('clears every selection at once', async () => {
    stub([source(1, 'Nutanix'), source(2, 'Phoronix')]);
    const onConfig = vi.fn();
    renderPage(<Harness initial={{ sourceIds: [1, 2] }} onConfig={onConfig} />);

    expect(await screen.findByText('2 selected')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onConfig).toHaveBeenLastCalledWith(expect.objectContaining({ sourceIds: [] }));
  });

  it('says so when nothing matches the search', async () => {
    stub(many);
    renderPage(<Harness />);

    await userEvent.type(await screen.findByLabelText('Filter sources'), 'nothing here');

    expect(screen.getByText('No source matches "nothing here".')).toBeTruthy();
  });
});

describe('the source filter when there are no sources', () => {
  it('shows neither the picker nor a count', async () => {
    stub([]);
    renderPage(<Harness />);

    // The tag fieldset is gated the same way; a form of empty fieldsets reads as
    // broken rather than as "you have not added anything yet".
    expect(await screen.findByLabelText('Items')).toBeTruthy();
    expect(screen.queryByText(/Draws from/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Only these sources' })).toBeNull();
  });
});

describe('the picker rows', () => {
  it('marks an inactive source rather than hiding it', async () => {
    stub([source(1, 'Nutanix'), source(2, 'Retired', { active: false })]);
    renderPage(<Harness />);

    // Queried through the title rather than the checkbox: a label wrapping its
    // input lends the input its whole text, so the accessible name here is
    // "RetiredInactive", and it becomes "RetiredStorage" the moment a tag is on
    // the row.
    const row = (await screen.findByText('Retired')).closest('li') as HTMLElement;
    expect(within(row).getByText('Inactive')).toBeTruthy();
    expect(within(row).getByRole('checkbox')).toBeTruthy();
  });

  it('shows a source with its tags', async () => {
    stub([source(1, 'Nutanix', { tags: [STORAGE] })]);
    renderPage(<Harness />);

    const row = (await screen.findByText('Nutanix')).closest('li') as HTMLElement;
    expect(within(row).getByText('Storage')).toBeTruthy();
  });
});
