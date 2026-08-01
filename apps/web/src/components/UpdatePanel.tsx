/**
 * "Is this the newest build?"
 *
 * Four states, and the distinction between them is the whole point: `unknown`
 * is not `up_to_date`. A dev run with no build sha, and GitHub being
 * unreachable, both mean "cannot say" -- and saying "Up to date" there would be
 * the one answer that is actively misleading.
 */

import { useState, type ReactNode } from 'react';
import type { UpdateRun, UpdateStatus } from '@nexuscentral/shared';
import { useCheckForUpdate, useRunUpdate, useUpdateStatus } from '../api/queries.ts';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, relativeTime } from '../lib/format.ts';
import { Button, Notice, Panel } from './ui.tsx';
import { Modal } from './Modal.tsx';

const TONE = {
  up_to_date: 'success',
  update_available: 'warning',
  unknown: 'info',
  disabled: 'info',
} as const;

function headline(status: UpdateStatus, t: Translate): string {
  if (status.state === 'unknown' && status.reason !== null) {
    return t(`settings.update.unknown.${status.reason}`);
  }
  return t(`settings.update.state.${status.state}`);
}

/** Tone per run state. `unclaimed` is a warning: it means nothing is listening. */
const RUN_TONE = {
  unavailable: 'info',
  idle: 'info',
  requested: 'info',
  unclaimed: 'warning',
  running: 'info',
  succeeded: 'success',
  failed: 'error',
} as const;

function RunReport({ run, t }: { run: UpdateRun; t: Translate }): ReactNode {
  if (run.state === 'idle' || run.state === 'unavailable') return null;

  return (
    <div className="space-y-1">
      <Notice tone={RUN_TONE[run.state]}>{t(`settings.update.run.${run.state}`)}</Notice>

      {run.state === 'succeeded' && run.toSha !== null && (
        <p className="text-muted text-xs">
          {t('settings.update.run.deployed', {
            from: (run.fromSha ?? '').slice(0, 7),
            to: run.toSha.slice(0, 7),
          })}
        </p>
      )}

      {run.message !== null && run.state === 'failed' && (
        <p className="text-secondary text-xs">{run.message}</p>
      )}

      {/* Only on a failure, and only the tail. deploy.sh rolls back on a failed
          migration or health check, so what matters is why -- and that is at the
          end of the log, not in the three minutes of build output above it. */}
      {run.logTail !== null && (
        <pre className="bg-hovered text-secondary max-h-48 overflow-auto rounded p-2 text-xs">
          {run.logTail}
        </pre>
      )}
    </div>
  );
}

export function UpdatePanel(): ReactNode {
  const t = useT();
  const status = useUpdateStatus();
  const check = useCheckForUpdate();
  const run = useRunUpdate();
  const [confirming, setConfirming] = useState(false);

  return (
    <Panel title={t('settings.update.title')} description={t('settings.update.intro')}>
      {status.isPending && <p className="text-secondary text-sm">{t('common.loading')}</p>}

      {status.error !== null && <Notice tone="error">{status.error.message}</Notice>}

      {status.data !== undefined && (
        <div className="space-y-2">
          <Notice tone={TONE[status.data.state]}>{headline(status.data, t)}</Notice>

          <dl className="text-secondary space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted">{t('settings.update.running')}</dt>
              <dd className="font-mono">
                {status.data.current === null
                  ? t('settings.update.noSha')
                  : status.data.current.slice(0, 7)}
              </dd>
            </div>

            {status.data.latest !== null && (
              <div className="flex gap-2">
                <dt className="text-muted">{t('settings.update.latest')}</dt>
                <dd className="min-w-0">
                  <span className="font-mono">{status.data.latest}</span>
                  {status.data.latestAt !== null && (
                    <time
                      dateTime={status.data.latestAt}
                      title={absoluteTime(status.data.latestAt)}
                      className="text-muted ml-2"
                    >
                      {relativeTime(status.data.latestAt)}
                    </time>
                  )}
                  {status.data.latestSubject !== null && (
                    <span className="text-muted block truncate">{status.data.latestSubject}</span>
                  )}
                </dd>
              </div>
            )}
          </dl>

          <RunReport run={status.data.run} t={t} />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => check.mutate()}
              disabled={check.isPending || status.data.state === 'disabled'}
            >
              {check.isPending ? t('settings.update.checking') : t('settings.update.check')}
            </Button>

            {/* Offered only when there is something to install and a host agent
                to install it. Never on `unknown`: deploying on the strength of a
                check that failed is exactly the wrong response to not knowing. */}
            {status.data.state === 'update_available' &&
              status.data.run.state !== 'unavailable' && (
                <Button
                  variant="primary"
                  onClick={() => setConfirming(true)}
                  disabled={
                    run.isPending ||
                    status.data.run.state === 'requested' ||
                    status.data.run.state === 'running'
                  }
                >
                  {t('settings.update.run.start')}
                </Button>
              )}

            {status.data.compareUrl !== null && status.data.state === 'update_available' && (
              <a
                href={status.data.compareUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent text-sm hover:underline"
              >
                {t('settings.update.viewChanges')}
              </a>
            )}

            {/* The check is cached for thirty minutes, so "checked 20 minutes
                ago" explains why the button appeared to do nothing. */}
            <span className="text-muted text-xs">
              {t('settings.update.checkedAt', { when: relativeTime(status.data.checkedAt) })}
            </span>
          </div>

          {check.error !== null && <Notice tone="error">{check.error.message}</Notice>}
          {run.error !== null && <Notice tone="error">{run.error.message}</Notice>}
        </div>
      )}

      {confirming && (
        <Modal
          title={t('settings.update.confirm.title')}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  run.mutate();
                  setConfirming(false);
                }}
              >
                {t('settings.update.confirm.go')}
              </Button>
            </>
          }
        >
          {/* Said plainly because all three are true and none is obvious from a
              button labelled "Update now": the database is migrated, the app
              goes away for a few minutes, and this page will fail to load
              during it. */}
          <p className="text-secondary text-sm">{t('settings.update.confirm.body')}</p>
        </Modal>
      )}
    </Panel>
  );
}
