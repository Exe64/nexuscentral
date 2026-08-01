/**
 * The update indicator in the application bar.
 *
 * Most of these assert that it is *absent*. A badge that is lit when nothing is
 * wrong is a badge you stop seeing, and it would then be missing on the one day
 * it mattered.
 */

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { UpdateInfo, UpdateRun } from '@nexuscentral/shared';
import { UpdateIndicator, indicatorFor } from '../src/components/UpdateIndicator.tsx';
import { useUpdateStatus } from '../src/api/queries.ts';
import { renderPage, stubApi } from './helpers.tsx';

/**
 * Renders the moment the shared query has an answer.
 *
 * It subscribes to the same key as the indicator, so "loaded" on screen means
 * the indicator has already decided what to show -- which is what makes an
 * assertion about absence mean something.
 */
function Probe(): ReactNode {
  const status = useUpdateStatus();
  return <span>{status.isSuccess ? 'loaded' : 'pending'}</span>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function run(overrides: Partial<UpdateRun> = {}): UpdateRun {
  return {
    state: 'idle',
    requestedAt: null,
    startedAt: null,
    finishedAt: null,
    fromSha: null,
    toSha: null,
    message: null,
    logTail: null,
    ...overrides,
  };
}

function info(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    state: 'up_to_date',
    current: '6706714',
    latest: '6706714',
    latestSubject: 'feat: something',
    latestAt: '2026-07-30T10:00:00.000Z',
    compareUrl: null,
    checkedAt: '2026-07-31T12:00:00.000Z',
    reason: null,
    run: run(),
    ...overrides,
  };
}

const stub = (body: UpdateInfo) => stubApi({ 'GET /api/update': { body: { data: body } } });

describe('indicatorFor', () => {
  it('shows nothing while everything is current', () => {
    expect(indicatorFor(info())).toBeNull();
  });

  it('shows nothing before the first answer arrives', () => {
    expect(indicatorFor(undefined)).toBeNull();
  });

  it('shows nothing when the check could not tell', () => {
    // `unknown` is the normal state of a dev run, which has no build sha. A
    // badge permanently lit outside production is the same failure as a badge
    // permanently lit inside it.
    expect(indicatorFor(info({ state: 'unknown', reason: 'no_build_sha' }))).toBeNull();
    expect(indicatorFor(info({ state: 'unknown', reason: 'unreachable' }))).toBeNull();
  });

  it('shows nothing when checking is turned off', () => {
    expect(indicatorFor(info({ state: 'disabled' }))).toBeNull();
  });

  it('lights up when an update exists', () => {
    expect(indicatorFor(info({ state: 'update_available' }))?.key).toBe('available');
  });

  it('lets the run outrank the comparison', () => {
    // After a failed deploy the check still says "update available". Which of
    // the two facts is more useful is not close.
    const failed = info({ state: 'update_available', run: run({ state: 'failed' }) });
    expect(indicatorFor(failed)?.key).toBe('failed');

    const running = info({ state: 'update_available', run: run({ state: 'running' }) });
    expect(indicatorFor(running)?.key).toBe('running');

    const queued = info({ state: 'update_available', run: run({ state: 'requested' }) });
    expect(indicatorFor(queued)?.key).toBe('running');
  });

  it('flags a request nothing picked up', () => {
    expect(indicatorFor(info({ run: run({ state: 'unclaimed' }) }))?.key).toBe('unclaimed');
  });

  it('goes quiet once a run has succeeded', () => {
    // The panel still reports it; the bar has nothing left to ask of you.
    expect(indicatorFor(info({ run: run({ state: 'succeeded' }) }))).toBeNull();
  });
});

describe('the indicator in the bar', () => {
  it('is absent when there is nothing to say', async () => {
    stub(info());
    renderPage(
      <>
        <Probe />
        <UpdateIndicator />
      </>,
    );

    // The indicator renders nothing here, so there is no element to wait for and
    // no natural moment at which the absence becomes meaningful. Waiting on
    // `fetch` having been called is not enough -- it fires before React has
    // re-rendered with the answer, so the assertion ran against the pending
    // state and passed even with the badge shown unconditionally. Caught by
    // mutating the component, not by reading it.
    //
    // The probe shares the query key, so once it says `loaded` the indicator has
    // the same data and has rendered its verdict.
    await screen.findByText('loaded');

    expect(screen.queryByRole('link')).toBeNull();
  });

  it('links to the updates panel, not just to settings', async () => {
    stub(info({ state: 'update_available' }));
    renderPage(<UpdateIndicator />);

    const link = await screen.findByRole('link', { name: 'Update available' });
    // The hash is what makes the click land on the answer rather than at the top
    // of a long settings page.
    expect(link.getAttribute('href')).toBe('/settings#updates');
  });

  it('names the state for a screen reader, not only in colour', async () => {
    stub(info({ run: run({ state: 'failed' }) }));
    renderPage(<UpdateIndicator />);

    expect(await screen.findByRole('link', { name: 'Update failed' })).toBeTruthy();
  });

  it('says it is updating while the agent works', async () => {
    stub(info({ state: 'update_available', run: run({ state: 'running' }) }));
    renderPage(<UpdateIndicator />);

    expect(await screen.findByRole('link', { name: 'Updating…' })).toBeTruthy();
  });
});
