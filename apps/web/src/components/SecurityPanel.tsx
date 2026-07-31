/**
 * Password change and active sessions, on the Settings page.
 *
 * Changing the password revokes every other session server-side. That is stated
 * here rather than left as a surprise, because the usual reason to change a
 * password is that someone else has it.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  useChangePassword,
  useRevokeOtherSessions,
  useSessions,
  type SessionRecord,
} from '../api/queries.ts';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, relativeTime } from '../lib/format.ts';

/** Matches the server's own floor; the server still enforces it. */
const MIN_LENGTH = 12;

function SessionRow({ session, t }: { session: SessionRecord; t: Translate }): ReactNode {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 py-1 text-xs">
      <span className={session.current === true ? 'text-primary' : 'text-secondary'}>
        {session.current === true ? t('auth.sessions.current') : t('auth.sessions.other')}
      </span>
      {session.ip !== null && <span className="text-muted">{session.ip}</span>}
      <time
        className="text-muted"
        dateTime={session.lastSeenAt}
        title={absoluteTime(session.lastSeenAt)}
      >
        {relativeTime(session.lastSeenAt)}
      </time>
      {session.userAgent !== null && (
        <span className="text-muted w-full truncate" title={session.userAgent}>
          {session.userAgent}
        </span>
      )}
    </li>
  );
}

export function SecurityPanel(): ReactNode {
  const t = useT();
  const change = useChangePassword();
  const sessions = useSessions();
  const revokeOthers = useRevokeOtherSessions();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<number | null>(null);

  const mismatch = confirm !== '' && next !== confirm;
  const tooShort = next !== '' && next.length < MIN_LENGTH;
  const canSubmit = current !== '' && next !== '' && !mismatch && !tooShort && !change.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: (result) => {
          setCurrent('');
          setNext('');
          setConfirm('');
          setDone(result.revokedSessions);
          void sessions.refetch();
        },
      },
    );
  };

  const others = (sessions.data ?? []).filter((session) => session.current !== true).length;

  return (
    <section className="space-y-4">
      <h2 className="text-primary text-base font-semibold">{t('auth.security.title')}</h2>

      {/*
        Explicit htmlFor rather than wrapping the input, and the hint attached with
        aria-describedby rather than nested inside the label. Nesting it makes the
        field's accessible name "New passwordAt least 12 characters…", which is
        what a screen reader would then announce.
      */}
      <form onSubmit={submit} className="max-w-sm space-y-3 text-sm" noValidate>
        <div>
          <label htmlFor="password-current" className="text-secondary block">
            {t('auth.password.current')}
          </label>
          <input
            id="password-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className="mt-1 block w-full"
          />
        </div>

        <div>
          <label htmlFor="password-new" className="text-secondary block">
            {t('auth.password.new')}
          </label>
          <input
            id="password-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            className="mt-1 block w-full"
            aria-describedby="password-new-hint"
            aria-invalid={tooShort ? true : undefined}
          />
          <p id="password-new-hint" className="text-muted mt-0.5 text-xs">
            {t('auth.password.hint', { min: MIN_LENGTH })}
          </p>
        </div>

        <div>
          <label htmlFor="password-confirm" className="text-secondary block">
            {t('auth.password.confirm')}
          </label>
          <input
            id="password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="mt-1 block w-full"
            aria-invalid={mismatch ? true : undefined}
          />
        </div>

        {mismatch && (
          <p role="alert" className="text-negative text-xs">
            {t('auth.password.mismatch')}
          </p>
        )}
        {change.error !== null && (
          <p role="alert" className="text-negative text-xs">
            {change.error.message}
          </p>
        )}
        {done !== null && (
          <p role="status" className="text-positive text-xs">
            {t('auth.password.changed', { count: done })}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="bg-accent text-accent-fg rounded px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {change.isPending ? t('auth.password.saving') : t('auth.password.save')}
        </button>
      </form>

      <div>
        <h3 className="text-secondary text-sm font-medium">{t('auth.sessions.title')}</h3>
        {sessions.data === undefined ? (
          <p className="text-muted text-xs">{t('common.loading')}</p>
        ) : (
          <>
            <ul className="divide-subtle mt-1 divide-y">
              {sessions.data.map((session) => (
                <SessionRow key={session.id} session={session} t={t} />
              ))}
            </ul>
            {others > 0 && (
              <button
                type="button"
                onClick={() => revokeOthers.mutate()}
                disabled={revokeOthers.isPending}
                className="border-subtle text-secondary hover:bg-hovered mt-2 rounded border px-2 py-1 text-xs"
              >
                {t('auth.sessions.revokeOthers', { count: others })}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
