/**
 * Decides between the login screen and the application.
 *
 * Wraps the router rather than sitting inside it: with no session there is no
 * route worth resolving, and putting the check on each route is how one gets
 * forgotten.
 */

import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useSession } from '../api/queries.ts';
import { setUnauthorizedHandler } from '../api/client.ts';
import { useT } from '../i18n.tsx';
import { Login } from '../pages/Login.tsx';

export function AuthGate({ children }: { children: ReactNode }): ReactNode {
  const t = useT();
  const client = useQueryClient();
  const session = useSession();

  // A session can expire under any request. When one comes back 401, re-ask who
  // we are; the answer flips this component to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      client.setQueryData(keys.session, { authenticated: false, configured: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [client]);

  if (session.isPending) {
    // Deliberately bare. Anything richer here flashes on every load, and this
    // resolves in one round trip.
    return <div className="bg-base min-h-screen" aria-busy="true" />;
  }

  if (session.error !== null) {
    return (
      <main className="bg-base flex min-h-screen items-center justify-center p-4">
        <div className="max-w-sm text-center">
          <p role="alert" className="text-negative text-sm">
            {t('health.unreachable')}
          </p>
          <button
            type="button"
            onClick={() => void session.refetch()}
            className="border-subtle text-secondary hover:bg-hovered mt-3 rounded border px-3 py-1.5 text-sm"
          >
            {t('common.retry')}
          </button>
        </div>
      </main>
    );
  }

  if (session.data?.authenticated !== true) return <Login />;

  return <>{children}</>;
}
