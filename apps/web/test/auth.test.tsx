/**
 * The login flow, from the browser's side.
 *
 * The one that matters most is the last group: a session can expire under any
 * request, and the shell has to notice without the user pressing anything.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from '../src/components/AuthGate.tsx';
import { SecurityPanel } from '../src/components/SecurityPanel.tsx';
import { useLogout, useTags } from '../src/api/queries.ts';
import { HEALTH_OK, renderPage, stubApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ANONYMOUS = { body: { data: { authenticated: false, configured: true } } };
const SIGNED_IN = { body: { data: { authenticated: true, configured: true } } };

function Protected(): React.ReactNode {
  // Any authenticated query will do; this one proves the shell got as far as
  // asking the API for something.
  const tags = useTags();
  return <p>{tags.isPending ? 'loading' : `tags: ${tags.data?.length ?? 0}`}</p>;
}

describe('AuthGate', () => {
  it('shows the login screen when there is no session', async () => {
    stubApi({ 'GET /api/auth/session': ANONYMOUS });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );

    expect(await screen.findByLabelText('Password')).toBeDefined();
    // The protected tree must not render at all -- not even briefly.
    expect(screen.queryByText(/^tags:/)).toBeNull();
  });

  it('does not request anything protected while signed out', async () => {
    const { calls } = stubApi({ 'GET /api/auth/session': ANONYMOUS });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );
    await screen.findByLabelText('Password');

    expect(calls.filter((call) => call.includes('/api/tags'))).toEqual([]);
  });

  it('renders the application once authenticated', async () => {
    stubApi({
      'GET /api/auth/session': SIGNED_IN,
      'GET /api/tags': { body: { data: [] } },
    });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );

    expect(await screen.findByText('tags: 0')).toBeDefined();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('offers a retry when the API cannot be reached at all', async () => {
    stubApi({ 'GET /api/auth/session': { status: 502, body: {} } });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});

describe('signing in', () => {
  it('posts the password and reveals the application', async () => {
    // One stub, one flag: the server only knows the session exists after the
    // login call, which is exactly the sequence being tested.
    let authenticated = false;
    const calls: string[] = [];

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);

      if (url.includes('/api/auth/login')) {
        authenticated = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes('/api/auth/session')) {
        return Promise.resolve(json({ data: { authenticated, configured: true } }));
      }
      if (url.includes('/api/tags')) {
        return Promise.resolve(json({ data: [{ id: 1 }] }));
      }
      return Promise.resolve(json({}));
    });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );

    await userEvent.type(await screen.findByLabelText('Password'), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('tags: 1')).toBeDefined();
    expect(calls.some((call) => call === 'POST /api/auth/login')).toBe(true);
  });

  it('reports a wrong password and clears the field', async () => {
    stubApi({
      'GET /api/auth/session': ANONYMOUS,
      'POST /api/auth/login': {
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'Incorrect password.' } },
      },
    });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );

    const field = (await screen.findByLabelText('Password')) as HTMLInputElement;
    await userEvent.type(field, 'wrong-but-long-enough');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Incorrect password.');
    // Never leave a password sitting in a form field after a failure.
    await waitFor(() => {
      expect(field.value).toBe('');
    });
  });

  it('says something different when the rate limiter trips', async () => {
    stubApi({
      'GET /api/auth/session': ANONYMOUS,
      'POST /api/auth/login': {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'Too many failed attempts.' } },
      },
    });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );

    await userEvent.type(await screen.findByLabelText('Password'), 'wrong-but-long-enough');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // "Incorrect password" would send the user round the loop that locked them out.
    expect((await screen.findByRole('alert')).textContent).toContain('Too many failed attempts');
  });

  it('masks the field and marks it for a password manager', async () => {
    stubApi({ 'GET /api/auth/session': ANONYMOUS });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );

    const field = await screen.findByLabelText('Password');
    expect(field.getAttribute('type')).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
  });

  it('will not submit an empty password', async () => {
    const { calls } = stubApi({ 'GET /api/auth/session': ANONYMOUS });

    renderPage(
      <AuthGate>
        <Protected />
      </AuthGate>,
    );

    const button = await screen.findByRole('button', { name: 'Sign in' });
    expect(button).toHaveProperty('disabled', true);
    await userEvent.click(button);
    expect(calls).not.toContain('POST /api/auth/login');
  });
});

describe('signing out', () => {
  it('returns to the login screen and drops the cached data', async () => {
    let authenticated = true;
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      if (url.includes('/api/auth/logout')) {
        authenticated = false;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes('/api/auth/session')) {
        return Promise.resolve(json({ data: { authenticated, configured: true } }));
      }
      if (url.includes('/api/tags')) return Promise.resolve(json({ data: [{ id: 1 }] }));
      return Promise.resolve(json({}));
    });

    function WithSignOut(): React.ReactNode {
      const tags = useTags();
      const logout = useLogout();
      return (
        <>
          <p>{`tags: ${tags.data?.length ?? '?'}`}</p>
          <button type="button" onClick={() => logout.mutate()}>
            sign out
          </button>
        </>
      );
    }

    renderPage(
      <AuthGate>
        <WithSignOut />
      </AuthGate>,
    );

    expect(await screen.findByText('tags: 1')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(await screen.findByLabelText('Password')).toBeDefined();
    // The protected view is gone, not merely hidden.
    expect(screen.queryByText('tags: 1')).toBeNull();
  });
});

describe('a session that expires mid-use', () => {
  it('sends the shell back to the login screen without a reload', async () => {
    let sessionValid = true;

    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);

      if (url.includes('/api/auth/session')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { authenticated: sessionValid, configured: true } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }

      if (url.includes('/api/tags')) {
        if (sessionValid) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        );
      }

      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    function Refetcher(): React.ReactNode {
      const tags = useTags();
      return (
        <>
          <p>{tags.isError ? 'error' : `tags: ${tags.data?.length ?? '?'}`}</p>
          <button type="button" onClick={() => void tags.refetch()}>
            refetch
          </button>
        </>
      );
    }

    renderPage(
      <AuthGate>
        <Refetcher />
      </AuthGate>,
    );

    expect(await screen.findByText('tags: 0')).toBeDefined();

    // The server forgets the session; the next request is the first the client
    // hears of it.
    sessionValid = false;
    await userEvent.click(screen.getByRole('button', { name: 'refetch' }));

    expect(await screen.findByLabelText('Password')).toBeDefined();
  });
});

describe('SecurityPanel', () => {
  const ROUTES = {
    'GET /api/auth/sessions': {
      body: {
        data: [
          {
            id: 1,
            createdAt: '2026-07-30T10:00:00.000Z',
            lastSeenAt: '2026-07-30T12:00:00.000Z',
            expiresAt: '2026-08-30T10:00:00.000Z',
            userAgent: 'Firefox',
            ip: '10.0.0.1',
            current: true,
          },
          {
            id: 2,
            createdAt: '2026-07-01T10:00:00.000Z',
            lastSeenAt: '2026-07-02T12:00:00.000Z',
            expiresAt: '2026-08-01T10:00:00.000Z',
            userAgent: 'Chrome',
            ip: '10.0.0.2',
            current: false,
          },
        ],
      },
    },
    'GET /api/health': HEALTH_OK,
  };

  it('will not submit when the two new passwords differ', async () => {
    const { calls } = stubApi(ROUTES);
    renderPage(<SecurityPanel />);

    await userEvent.type(screen.getByLabelText('Current password'), 'old-long-password');
    await userEvent.type(screen.getByLabelText('New password'), 'new-long-password-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'new-long-password-2');

    expect(screen.getByRole('alert').textContent).toContain('do not match');
    expect(screen.getByRole('button', { name: 'Change password' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(calls).not.toContain('POST /api/auth/password');
  });

  it('will not submit a new password below the length floor', async () => {
    stubApi(ROUTES);
    renderPage(<SecurityPanel />);

    await userEvent.type(screen.getByLabelText('Current password'), 'old-long-password');
    await userEvent.type(screen.getByLabelText('New password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'short');

    expect(screen.getByRole('button', { name: 'Change password' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('says how many other sessions the change signed out', async () => {
    stubApi({ ...ROUTES, 'POST /api/auth/password': { body: { data: { revokedSessions: 3 } } } });
    renderPage(<SecurityPanel />);

    await userEvent.type(screen.getByLabelText('Current password'), 'old-long-password');
    await userEvent.type(screen.getByLabelText('New password'), 'a-new-long-password');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a-new-long-password');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('3');
  });

  it('lists the sessions and marks this device', async () => {
    stubApi(ROUTES);
    renderPage(<SecurityPanel />);

    expect(await screen.findByText('This device')).toBeDefined();
    expect(screen.getByText('Other device')).toBeDefined();
    expect(screen.getByRole('button', { name: /Sign out 1 other/ })).toBeDefined();
  });
});
