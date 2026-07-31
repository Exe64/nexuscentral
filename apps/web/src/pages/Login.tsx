/**
 * The login screen.
 *
 * Shown instead of the shell whenever there is no session, at any route. There is
 * no "remember me": the session already lasts thirty days, and a checkbox that
 * only shortens it would be a worse default pretending to be a choice.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLogin } from '../api/queries.ts';
import { ApiRequestError } from '../api/client.ts';
import { useT } from '../i18n.tsx';

export function Login(): ReactNode {
  const t = useT();
  const login = useLogin();
  const [password, setPassword] = useState('');
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const error = login.error;
  const rateLimited = error instanceof ApiRequestError && error.code === 'RATE_LIMITED';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (password === '' || login.isPending) return;
    login.mutate(
      { password },
      {
        // Never leave the password sitting in a state field after a failure.
        onSettled: () => setPassword(''),
        onError: () => field.current?.focus(),
      },
    );
  };

  return (
    <main className="bg-base flex min-h-screen items-center justify-center p-4">
      <div className="bg-surface border-subtle w-full max-w-sm rounded-lg border p-6 shadow-sm">
        <h1 className="text-primary mb-1 text-lg font-semibold">{t('app.name')}</h1>
        <p className="text-secondary mb-5 text-sm">{t('login.intro')}</p>

        <form onSubmit={submit} noValidate>
          <label htmlFor="login-password" className="text-secondary block text-sm">
            {t('login.password')}
          </label>
          <input
            id="login-password"
            ref={field}
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 block w-full"
            aria-describedby={error === null ? undefined : 'login-error'}
            aria-invalid={error === null ? undefined : true}
          />

          {error !== null && (
            <p id="login-error" role="alert" className="text-negative mt-3 text-sm">
              {rateLimited ? t('login.rateLimited') : t('login.failed')}
            </p>
          )}

          <button
            type="submit"
            disabled={password === '' || login.isPending}
            className="bg-accent text-accent-fg mt-4 w-full rounded px-3 py-2 text-sm disabled:opacity-50"
          >
            {login.isPending ? t('login.submitting') : t('login.submit')}
          </button>
        </form>
      </div>
    </main>
  );
}
