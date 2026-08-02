/**
 * The update panel, and the one thing it must never say.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdateInfo, UpdateRun } from '@nexuscentral/shared';
import { UpdatePanel } from '../src/components/UpdatePanel.tsx';
import { renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function run(overrides: Partial<UpdateRun> = {}): UpdateRun {
  return {
    state: 'unavailable',
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

function status(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    state: 'up_to_date',
    current: '6706714',
    latest: '6706714',
    latestSubject: 'feat: something',
    latestAt: '2026-07-30T10:00:00.000Z',
    compareUrl: 'https://github.com/Exe64/nexuscentral/compare/6706714...main',
    checkedAt: '2026-07-31T12:00:00.000Z',
    reason: null,
    run: run(),
    ...overrides,
  };
}

function stub(body: UpdateInfo, forced?: UpdateInfo) {
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

    expect(await screen.findByText(/nothing to compare the repository against/)).toBeTruthy();
  });

  it('does not lay out a comparison it did not make', async () => {
    // Reported from a dev run: "Running: unknown" stacked over "Latest: b5638d9"
    // was read as "a newer commit was found", because two rows in a list are a
    // comparison table whatever the notice above them says. There is no verdict
    // when the build carries no sha, so there is no second row to compare with.
    stub(status({ state: 'unknown', reason: 'no_build_sha', current: null, latest: 'b5638d9' }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Newest on main')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText('Latest')).toBeNull();
  });

  it('lays one out when it did make one', async () => {
    stub(status({ state: 'update_available', current: '2519531', latest: 'b5638d9' }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Running')).toBeTruthy();
    expect(screen.getByText('Latest')).toBeTruthy();
    expect(screen.queryByText('Newest on main')).toBeNull();
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

  it('offers no update button when the host has no agent, and says why', async () => {
    // `unavailable` means no control directory. Withholding the button is right,
    // it cannot succeed -- but withholding the reason was not. Reported from a
    // live install: "Update available" with nothing to press and no explanation
    // anywhere except the README.
    stub(status({ state: 'update_available', run: run({ state: 'unavailable' }) }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Update available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.getByText(/In-app updating is not set up on this host/)).toBeTruthy();
    expect(screen.getByText(/UPDATE_CONTROL_DIR/)).toBeTruthy();
  });

  it('stays quiet about the missing agent when there is nothing to update to', async () => {
    // True but irrelevant today, and the panel is not the place to list every
    // optional thing that is switched off.
    stub(status({ state: 'up_to_date', run: run({ state: 'unavailable' }) }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Up to date')).toBeTruthy();
    expect(screen.queryByText(/In-app updating is not set up/)).toBeNull();
  });

  it('offers no update button when it cannot tell whether there is one', async () => {
    // Deploying on the strength of a check that failed is the wrong response to
    // not knowing.
    stub(status({ state: 'unknown', reason: 'unreachable', run: run({ state: 'idle' }) }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText(/GitHub could not be reached/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
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

describe('running the update', () => {
  function ready(runOverrides: Partial<UpdateRun> = {}) {
    return status({ state: 'update_available', run: run({ state: 'idle', ...runOverrides }) });
  }

  it('asks before doing anything, and says what it will do', async () => {
    stubApi({
      'GET /api/update': { body: { data: ready() } },
      'POST /api/update/run': { body: { data: run({ state: 'requested' }) } },
    });
    renderPage(<UpdatePanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'Update now' }));

    const dialog = screen.getByRole('dialog', { name: 'Update now?' });
    // The three facts a button label cannot carry: the database is migrated, the
    // app goes away, and this page stops loading while it does.
    expect(dialog.textContent).toContain('migrate');
    expect(dialog.textContent).toContain('unavailable');
    // Nothing has been requested yet.
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('does nothing when the confirmation is cancelled', async () => {
    stubApi({
      'GET /api/update': { body: { data: ready() } },
      'POST /api/update/run': { body: { data: run({ state: 'requested' }) } },
    });
    renderPage(<UpdatePanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('posts the request once confirmed', async () => {
    stubApi({
      'GET /api/update': { body: { data: ready() } },
      'POST /api/update/run': { body: { data: run({ state: 'requested' }) } },
    });
    renderPage(<UpdatePanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url, init]) =>
              String(url).endsWith('/api/update/run') &&
              (init as RequestInit | undefined)?.method === 'POST',
          ),
      ).toBe(true);
    });
  });

  it('warns that the app will be unavailable while it deploys', async () => {
    stub(ready({ state: 'running', startedAt: '2026-07-31T12:00:00.000Z' }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText(/this page may fail to load/)).toBeTruthy();
  });

  it('shows how far along a running deploy is', async () => {
    // Asked directly: "how do I know where the update process is at?" It took
    // minutes and the panel said only "Deploying", which reads the same at
    // thirty seconds and at half an hour.
    stub(
      ready({
        state: 'running',
        startedAt: new Date(Date.now() - 90_000).toISOString(),
        logTail: '=== building api ===\nStep 4/12 : COPY packages/shared',
      }),
    );
    renderPage(<UpdatePanel />);

    expect(await screen.findByText(/^Started /)).toBeTruthy();
    expect(screen.getByText(/Step 4\/12/)).toBeTruthy();
  });

  it('reports a finished update with the commits it moved between', async () => {
    stub(
      status({
        run: run({ state: 'succeeded', fromSha: '2519531', toSha: '6706714' }),
      }),
    );
    renderPage(<UpdatePanel />);

    expect(await screen.findByText('Deployed 2519531 → 6706714.')).toBeTruthy();
  });

  it('shows the log tail when the deploy failed', async () => {
    stub(
      status({
        run: run({
          state: 'failed',
          message: 'deploy.sh exited 1.',
          logTail: 'ERROR: relation "items" does not exist',
        }),
      }),
    );
    renderPage(<UpdatePanel />);

    expect(await screen.findByText(/rolls back to the previous commit/)).toBeTruthy();
    expect(screen.getByText(/relation "items" does not exist/)).toBeTruthy();
  });

  it('says when nothing picked the request up', async () => {
    // The failure mode of an agent that was never installed. Left as "queued" it
    // would look like a working button that does nothing.
    stub(ready({ state: 'unclaimed', requestedAt: '2026-07-31T11:00:00.000Z' }));
    renderPage(<UpdatePanel />);

    expect(await screen.findByText(/has not been picked up/)).toBeTruthy();
  });
});
