import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../src/pages/Settings.tsx';
import { useThemeStore } from '../src/theme/store.ts';
import { renderPage, stubApi } from './helpers.tsx';

beforeEach(() => {
  localStorage.clear();
  // The theme store is a module singleton: without this, a palette chosen in one
  // test is still selected in the next.
  useThemeStore.getState().adoptFromServer({
    mode: 'system',
    preset: 'default',
    hue: 250,
    chroma: 0.14,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    themeMode: 'system',
    themePreset: 'default',
    accentHue: 250,
    accentChroma: 0.14,
    itemsRetentionDays: 90,
    alertWebhookUrl: null,
    alertWebhookKind: 'none',
    reddit: { configured: false, origin: null, envOverridesSettings: false },
    nitterBaseUrls: [],
    nitterBaseUrlsOrigin: 'env',
    updatedAt: '2026-07-30T09:00:00.000Z',
    ...overrides,
  };
}

describe('Reddit panel', () => {
  it('explains that Reddit sources stay inactive until it is configured', async () => {
    stubApi({ 'GET /api/settings': { body: { data: settings() } } });

    renderPage(<Settings />);

    expect(await screen.findByText(/Reddit sources stay inactive/)).toBeDefined();
    // The registration lead time is the thing a user needs to know on day one.
    expect(screen.getByText(/two to four weeks/)).toBeDefined();
  });

  it('warns when the environment shadows the stored credentials', async () => {
    stubApi({
      'GET /api/settings': {
        body: {
          data: settings({
            reddit: { configured: true, origin: 'env', envOverridesSettings: true },
          }),
        },
      },
    });

    renderPage(<Settings />);

    // Otherwise saving the form looks like a no-op with no explanation.
    expect(await screen.findByText(/take precedence/)).toBeDefined();
  });

  it('omits an untouched secret from the patch, so it is not overwritten', async () => {
    stubApi({
      'GET /api/settings': { body: { data: settings() } },
      'PATCH /api/settings': { body: { data: settings() } },
    });

    renderPage(<Settings />);

    await userEvent.type(await screen.findByLabelText('Client ID'), 'client-abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save Reddit credentials' }));

    await waitFor(() => {
      const patch = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        redditClientId: 'client-abc',
      });
    });
  });

  it('sends explicit nulls to clear stored credentials', async () => {
    stubApi({
      'GET /api/settings': {
        body: {
          data: settings({
            reddit: { configured: true, origin: 'settings', envOverridesSettings: false },
          }),
        },
      },
      'PATCH /api/settings': { body: { data: settings() } },
    });

    renderPage(<Settings />);

    await userEvent.click(await screen.findByRole('button', { name: 'Clear stored credentials' }));

    await waitFor(() => {
      const patch = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      // A blank field means "unchanged"; clearing has to be explicit.
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        redditClientId: null,
        redditClientSecret: null,
      });
    });
  });

  it('reports a rejected test with the server message', async () => {
    stubApi({
      'GET /api/settings': { body: { data: settings() } },
      'POST /api/settings/test-reddit': {
        body: {
          data: {
            ok: false,
            reason: 'rejected',
            message: 'Reddit rejected the client id and secret. Check them in Settings.',
          },
        },
      },
    });

    renderPage(<Settings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(/Reddit rejected the client id/)).toBeDefined();
  });

  it('reports a successful test with the budget state', async () => {
    stubApi({
      'GET /api/settings': { body: { data: settings() } },
      'POST /api/settings/test-reddit': {
        body: {
          data: {
            ok: true,
            origin: 'settings',
            budget: { remaining: 596, resetIn: 540, utilisation: 0.006 },
          },
        },
      },
    });

    renderPage(<Settings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(/accepted the credentials from settings/)).toBeDefined();
    expect(screen.getByText(/596 requests left/)).toBeDefined();
  });
});

describe('Appearance panel', () => {
  it('offers every palette and explains what each one is', async () => {
    stubApi({ 'GET /api/settings': { body: { data: settings() } } });

    renderPage(<Settings />);

    for (const name of ['Default', 'Solarized', 'Terminal', 'VT220', 'PowerShell']) {
      expect(await screen.findByRole('radio', { name })).toBeDefined();
    }
    // The adaptation is stated rather than hidden behind the name.
    await userEvent.click(screen.getByRole('radio', { name: 'Solarized' }));
    expect(await screen.findByText(/4\.13:1/)).toBeDefined();
  });

  it('saves the palette and the mode it forced', async () => {
    stubApi({
      'GET /api/settings': { body: { data: settings() } },
      'PATCH /api/settings': { body: { data: settings({ themePreset: 'vt220' }) } },
    });

    renderPage(<Settings />);
    await userEvent.click(await screen.findByRole('radio', { name: 'VT220' }));

    await waitFor(() => {
      const patch = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      // Amber phosphor is a dark palette; persisting only the preset would leave
      // the stored mode disagreeing with what is on screen.
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        themePreset: 'vt220',
        themeMode: 'dark',
      });
    });
  });

  it('says the accent does nothing under a preset rather than leaving a dead control', async () => {
    stubApi({
      'GET /api/settings': { body: { data: settings({ themePreset: 'terminal' }) } },
      'PATCH /api/settings': { body: { data: settings({ themePreset: 'terminal' }) } },
    });

    renderPage(<Settings />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Terminal' }));

    expect(await screen.findByText(/sets its own colours/)).toBeDefined();
  });

  it('keeps the accent controls live on the default palette', async () => {
    stubApi({ 'GET /api/settings': { body: { data: settings() } } });

    renderPage(<Settings />);
    await screen.findByRole('radio', { name: 'Default' });

    expect(screen.queryByText(/sets its own colours/)).toBeNull();
    expect(screen.getByLabelText(/Accent hue/)).toBeDefined();
  });
});

describe('Nitter panel', () => {
  it('says when the environment default is in use', async () => {
    stubApi({
      'GET /api/settings': {
        body: {
          data: settings({
            nitterBaseUrls: ['https://nitter.mydomain.tld'],
            nitterBaseUrlsOrigin: 'env',
          }),
        },
      },
    });

    renderPage(<Settings />);

    expect(await screen.findByText(/Saving here overrides it/)).toBeDefined();
  });

  it('sends one URL per line, trimmed, dropping blanks', async () => {
    stubApi({
      'GET /api/settings': { body: { data: settings() } },
      'PATCH /api/settings': { body: { data: settings() } },
    });

    renderPage(<Settings />);

    const textarea = await screen.findByLabelText(/Instance base URLs/);
    await userEvent.clear(textarea);
    await userEvent.type(
      textarea,
      'https://nitter.mydomain.tld{enter}{enter}  https://nitter.backup.example.net  ',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save instances' }));

    await waitFor(() => {
      const patch = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        nitterBaseUrls: ['https://nitter.mydomain.tld', 'https://nitter.backup.example.net'],
      });
    });
  });

  it('reports every instance, including the ones that failed', async () => {
    stubApi({
      'GET /api/settings': {
        body: {
          data: settings({
            nitterBaseUrls: ['https://a.example', 'https://b.example'],
            nitterBaseUrlsOrigin: 'settings',
          }),
        },
      },
      'POST /api/settings/test-nitter': {
        body: {
          data: {
            ok: true,
            instances: [
              {
                baseUrl: 'https://a.example',
                ok: true,
                itemCount: 20,
                durationMs: 180,
                message: 'Returned 20 items',
              },
              {
                baseUrl: 'https://b.example',
                ok: false,
                itemCount: 0,
                durationMs: 90,
                message: 'Returned a well-formed but empty feed',
              },
            ],
          },
        },
      },
    });

    renderPage(<Settings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test instances' }));

    expect(await screen.findByText(/a\.example — Returned 20 items \(180ms\)/)).toBeDefined();
    // The list is ordered, so a dead entry is dead weight the user should see.
    expect(screen.getByText(/b\.example — Returned a well-formed but empty feed/)).toBeDefined();
  });
});
