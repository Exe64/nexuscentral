/**
 * The update panel, and the one thing it must never say.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdateStatus } from '@nexuscentral/shared';
import { UpdatePanel } from '../src/components/UpdatePanel.tsx';
import { renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    state: 'up_to_date',
    current: '6706714',
    latest: '6706714',
    latestSubject: 'feat: something',
    latestAt: '2026-07-30T10:00:00.000Z',
    compareUrl: 'https://github.com/Exe64/nexuscentral/compare/6706714...main',
    checkedAt: '2026-07-31T12:00:00.000Z',
    reason: null,
    ...overrides,
  };
}

function stub(body: UpdateStatus, forced?: UpdateStatus) {
  return stubApi({
    'GET /api/update': { body: { data: body } },
    'GET /api/update?force=true': { body: { data: forced ?? body } },
  });
}

describe('the update panel', () => {
  it('says up to date', async () => {
    stub(status());
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Up to date')).toBeTruthy();
  });

  it('says an update is available and links the changes', async () => {
    stub(status({ state: 'update_available', latest: 'abc1234' }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Update available')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'View the changes on GitHub' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/Exe64/nexuscentral/compare/6706714...main',
    );
  });

  it('offers no changes link when there is nothing to see', async () => {
    stub(status());
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Up to date')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'View the changes on GitHub' })).toBeNull();
  });

  it('never claims to be up to date when the check failed', async () => {
    // The load-bearing case. A wrong "Update available" costs a click; a wrong
    // "Up to date" means running a known-broken build and believing otherwise.
    stub(status({ state: 'unknown', reason: 'unreachable', latest: null, compareUrl: null }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Cannot tell: GitHub could not be reached.')).toBeTruthy();
    expect(screen.queryByText('Up to date')).toBeNull();
  });

  it('explains a missing build sha rather than shrugging', async () => {
    stub(status({ state: 'unknown', reason: 'no_build_sha', current: null }));
    renderPage(<UpdatePanel />);

    expect(
      await screen.findByText(
        'Cannot tell: this build carries no commit sha, which is normal outside a deployment.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('unknown')).toBeTruthy();
  });

  it('names the rate limit as its own cause', async () => {
    stub(status({ state: 'unknown', reason: 'rate_limited', latest: null }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText(/hourly rate limit is spent/)).toBeTruthy();
  });

  it('re-checks on demand and shows the new answer', async () => {
    stub(status({ state: 'update_available' }), status({ state: 'up_to_date' }));
    renderPage(<UpdatePanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));

    expect(await screen.findByText('Up to date')).toBeTruthy();
  });

  it('does not offer to check when checking is turned off', async () => {
    stub(status({ state: 'disabled', latest: null, compareUrl: null }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Update checking is turned off.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
