/**
 * "Is this the newest build?"
 *
 * Four states, and the distinction between them is the whole point: `unknown`
 * is not `up_to_date`. A dev run with no build sha, and GitHub being
 * unreachable, both mean "cannot say" -- and saying "Up to date" there would be
 * the one answer that is actively misleading.
 */

import type { ReactNode } from 'react';
import type { UpdateStatus } from '@nexuscentral/shared';
import { useCheckForUpdate, useUpdateStatus } from '../api/queries.ts';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, relativeTime } from '../lib/format.ts';
import { Button, Notice, Panel } from './ui.tsx';

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

export function UpdatePanel(): ReactNode {
  const t = useT();
  const status = useUpdateStatus();
  const check = useCheckForUpdate();

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

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => check.mutate()}
              disabled={check.isPending || status.data.state === 'disabled'}
            >
              {check.isPending ? t('settings.update.checking') : t('settings.update.check')}
            </Button>

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
        </div>
      )}
    </Panel>
  );
}
