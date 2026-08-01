/**
 * Editing a source after it exists: name, poll interval, weight, tags.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sources, intervalOptions } from '../src/pages/Sources.tsx';
import { makeSource, renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const TAGS = {
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
    ],
  },
};

function stub(sourceOverrides: Record<string, unknown> = {}) {
  return stubApi({
    'GET /api/sources': { body: { data: [makeSource(sourceOverrides)] } },
    'GET /api/tags': TAGS,
    'PATCH /api/sources/1': { body: { data: makeSource(sourceOverrides) } },
  });
}

function patchBody(): Record<string, unknown> {
  const call = vi
    .mocked(fetch)
    .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
  return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
}

async function openDialog(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.getByRole('dialog', { name: 'Edit source' });
}

describe('editing a source', () => {
  it('opens on the values the source already has', async () => {
    stub({ title: 'Nutanix Blog', pollInterval: '15 minutes', weight: 1 });
    renderPage(<Sources />);

    const dialog = await openDialog();

    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Nutanix Blog');
    expect((within(dialog).getByLabelText('Poll interval') as HTMLSelectElement).value).toBe(
      '15 minutes',
    );
    expect((within(dialog).getByLabelText('Weight') as HTMLInputElement).value).toBe('1');
  });

  it('saves a new poll interval', async () => {
    stub({ pollInterval: '15 minutes' });
    renderPage(<Sources />);

    const dialog = await openDialog();
    await userEvent.selectOptions(within(dialog).getByLabelText('Poll interval'), '6 hours');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchBody()['pollInterval']).toBe('6 hours'));
  });

  it('saves a renamed source, which resolved titles routinely need', async () => {
    // A subreddit added through the RSS fallback arrives as
    // "newest submissions : selfhosted".
    stub({ title: 'newest submissions : selfhosted' });
    renderPage(<Sources />);

    const dialog = await openDialog();
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'r/selfhosted');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchBody()['title']).toBe('r/selfhosted'));
  });

  it('refuses a weight outside the range the API accepts', async () => {
    // Caught here rather than as a round trip and a red banner.
    stub({ weight: 1 });
    renderPage(<Sources />);

    const dialog = await openDialog();
    const weight = within(dialog).getByLabelText('Weight');
    await userEvent.clear(weight);
    await userEvent.type(weight, '42');

    expect(await within(dialog).findByText('Weight must be between 0 and 10.')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes on cancel without sending anything', async () => {
    const api = stub();
    renderPage(<Sources />);

    const dialog = await openDialog();
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Changed');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.some((call) => call.startsWith('PATCH'))).toBe(false);
  });

  it('surfaces the API message rather than a generic failure', async () => {
    stubApi({
      'GET /api/sources': { body: { data: [makeSource()] } },
      'GET /api/tags': TAGS,
      'PATCH /api/sources/1': {
        status: 400,
        body: { error: { code: 'VALIDATION_FAILED', message: 'Poll interval must be at least 5' } },
      },
    });
    renderPage(<Sources />);

    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Knowing which field to fix is the difference between an error and a hint.
    expect(await screen.findByText(/Poll interval must be at least 5/)).toBeDefined();
    // Still open, so the edit is not lost.
    expect(screen.getByRole('dialog', { name: 'Edit source' })).toBeDefined();
  });
});

describe('intervalOptions', () => {
  it('offers the presets', () => {
    expect(intervalOptions('15 minutes')).toContain('1 hour');
    expect(intervalOptions('15 minutes')[0]).toBe('5 minutes');
  });

  it('keeps a value that is not one of them', () => {
    // OPML import and older rows carry intervals nobody would pick from a list.
    // Dropping it would silently reschedule the source on the next save.
    expect(intervalOptions('45 minutes')[0]).toBe('45 minutes');
    expect(intervalOptions('45 minutes')).toContain('1 hour');
  });

  it('does not list a preset twice', () => {
    const options = intervalOptions('1 hour');
    expect(new Set(options).size).toBe(options.length);
  });
});
