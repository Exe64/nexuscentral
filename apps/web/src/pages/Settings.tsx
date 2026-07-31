/**
 * `/settings` -- integrations and retention.
 *
 * Appearance (theme mode, accent hue and chroma) lands in Phase 4 with the theme
 * tokens. What is here is what Reddit and Nitter need to work at all.
 *
 * The secret is never returned by the API, so the field is always blank and an
 * empty submission means "leave it alone". Clearing is a separate, explicit action.
 */

import { useState, type ReactNode } from 'react';
import type { Settings as SettingsShape } from '@nexuscentral/shared';
import { useSettings, useTestNitter, useTestReddit, useUpdateSettings } from '../api/queries.ts';
import { AlertsPanel } from '../components/AlertsPanel.tsx';
import { AppearancePanel } from '../components/AppearancePanel.tsx';
import { SecurityPanel } from '../components/SecurityPanel.tsx';
import { Button, Notice, PageHeader, Panel } from '../components/ui.tsx';
import { useT, type Translate } from '../i18n.tsx';

const CONTROL = 'bg-surface border-subtle text-primary w-full rounded border px-2 py-1.5 text-sm';
const LABEL = 'text-secondary mb-1 block text-sm';

function RedditPanel({ settings, t }: { settings: SettingsShape; t: Translate }): ReactNode {
  const update = useUpdateSettings();
  const test = useTestReddit();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  return (
    <Panel title={t('settings.reddit.title')} description={t('settings.reddit.intro')}>
      {settings.reddit.configured ? (
        <Notice tone="success">
          {t('settings.reddit.configured', { origin: settings.reddit.origin ?? 'settings' })}
        </Notice>
      ) : (
        <Notice tone="info">{t('settings.reddit.notConfigured')}</Notice>
      )}

      {settings.reddit.envOverridesSettings && (
        // Saying this out loud, because otherwise saving the form looks like a
        // no-op and the user has no way to tell why.
        <div className="mt-2">
          <Notice tone="warning">{t('settings.reddit.envOverrides')}</Notice>
        </div>
      )}

      <form
        className="mt-3 max-w-sm space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate(
            {
              ...(clientId.trim() === '' ? {} : { redditClientId: clientId.trim() }),
              ...(clientSecret.trim() === '' ? {} : { redditClientSecret: clientSecret.trim() }),
            },
            { onSuccess: () => setClientSecret('') },
          );
        }}
      >
        <div>
          <label htmlFor="reddit-client-id" className={LABEL}>
            {t('settings.reddit.clientId')}
          </label>
          <input
            id="reddit-client-id"
            value={clientId}
            autoComplete="off"
            onChange={(event) => setClientId(event.target.value)}
            className={CONTROL}
          />
        </div>

        <div>
          <label htmlFor="reddit-client-secret" className={LABEL}>
            {t('settings.reddit.clientSecret')}
          </label>
          <input
            id="reddit-client-secret"
            type="password"
            value={clientSecret}
            autoComplete="new-password"
            placeholder={t('settings.reddit.secretPlaceholder')}
            onChange={(event) => setClientSecret(event.target.value)}
            className={CONTROL}
          />
        </div>

        <Button type="submit" variant="primary" disabled={update.isPending}>
          {t('settings.reddit.save')}
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="ghost"
          disabled={update.isPending}
          onClick={() => {
            // An explicit null clears the column; a blank field would only mean
            // "unchanged".
            update.mutate({ redditClientId: null, redditClientSecret: null });
            setClientId('');
            setClientSecret('');
          }}
        >
          {t('settings.reddit.clear')}
        </Button>

        <Button disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? t('settings.reddit.testing') : t('settings.reddit.test')}
        </Button>
      </div>

      {test.data !== undefined &&
        (test.data.ok ? (
          <div role="status" className="text-positive mt-3 space-y-1 text-sm">
            <p>{t('settings.reddit.testOk', { origin: test.data.origin ?? 'settings' })}</p>
            {test.data.budget?.remaining !== null && test.data.budget !== undefined && (
              <p className="text-muted text-xs">
                {t('settings.reddit.budget', {
                  remaining: test.data.budget.remaining ?? 0,
                  resetIn: test.data.budget.resetIn ?? 0,
                })}
              </p>
            )}
          </div>
        ) : (
          <div className="mt-3">
            <Notice tone="error">
              {t('settings.reddit.testFailed', { message: test.data.message ?? '' })}
            </Notice>
          </div>
        ))}

      {update.error !== null && (
        <div className="mt-3">
          <Notice tone="error">{t('error.generic', { message: update.error.message })}</Notice>
        </div>
      )}
      {update.isSuccess && (
        <div className="mt-3">
          <Notice tone="success">{t('settings.saved')}</Notice>
        </div>
      )}
    </Panel>
  );
}

function NitterPanel({ settings, t }: { settings: SettingsShape; t: Translate }): ReactNode {
  const update = useUpdateSettings();
  const test = useTestNitter();
  // Seeded once from the server, which includes the environment default when
  // nothing is stored. No effect syncs it afterwards: this panel only mounts once
  // the settings have loaded, and re-syncing would clobber an edit in progress
  // whenever a refetch landed.
  const [text, setText] = useState(settings.nitterBaseUrls.join('\n'));

  return (
    <Panel title={t('settings.nitter.title')} description={t('settings.nitter.intro')}>
      {settings.nitterBaseUrls.length === 0 ? (
        <Notice tone="info">{t('settings.nitter.none')}</Notice>
      ) : (
        <Notice tone="success">
          {settings.nitterBaseUrlsOrigin === 'env'
            ? t('settings.nitter.usingEnv')
            : t('settings.nitter.usingSettings')}
        </Notice>
      )}

      <form
        className="mt-3 max-w-sm space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate({
            nitterBaseUrls: text
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== ''),
          });
        }}
      >
        <div>
          <label htmlFor="nitter-urls" className={LABEL}>
            {t('settings.nitter.urls')}
          </label>
          <textarea
            id="nitter-urls"
            value={text}
            rows={4}
            onChange={(event) => setText(event.target.value)}
            className={`${CONTROL} font-mono text-xs`}
          />
        </div>
        <Button type="submit" variant="primary" disabled={update.isPending}>
          {t('settings.nitter.save')}
        </Button>
      </form>

      <div className="mt-3">
        <Button disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? t('settings.nitter.testing') : t('settings.nitter.test')}
        </Button>
      </div>

      {test.data !== undefined && (
        <div className="mt-3 space-y-1">
          {!test.data.ok && test.data.instances.length > 0 && (
            <Notice tone="error">{t('settings.nitter.allFailed')}</Notice>
          )}
          <ul className="space-y-0.5">
            {test.data.instances.map((instance) => (
              <li
                key={instance.baseUrl}
                className={instance.ok ? 'text-positive text-xs' : 'text-negative text-xs'}
              >
                {instance.ok
                  ? t('settings.nitter.instanceOk', {
                      baseUrl: instance.baseUrl,
                      message: instance.message,
                      durationMs: instance.durationMs,
                    })
                  : t('settings.nitter.instanceFailed', {
                      baseUrl: instance.baseUrl,
                      message: instance.message,
                    })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function RetentionPanel({ settings, t }: { settings: SettingsShape; t: Translate }): ReactNode {
  const update = useUpdateSettings();
  const [days, setDays] = useState(String(settings.itemsRetentionDays));

  return (
    <Panel title={t('settings.retention.title')} description={t('settings.retention.intro')}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = Number(days);
          if (!Number.isInteger(parsed) || parsed < 1) return;
          update.mutate({ itemsRetentionDays: parsed });
        }}
      >
        <div>
          <label htmlFor="retention-days" className={LABEL}>
            {t('settings.retention.days')}
          </label>
          <input
            id="retention-days"
            type="number"
            min={1}
            max={3650}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            className={`${CONTROL} w-28`}
          />
        </div>
        <Button type="submit" variant="primary" disabled={update.isPending} className="mb-0.5">
          {t('settings.retention.save')}
        </Button>
      </form>
      <p className="text-muted mt-2 text-xs">{t('settings.retention.starredNote')}</p>
    </Panel>
  );
}

export function Settings(): ReactNode {
  const t = useT();
  const settings = useSettings();

  if (settings.isPending) return <p className="text-secondary text-sm">{t('common.loading')}</p>;

  if (settings.error !== null) {
    return (
      <p role="alert" className="text-negative text-sm">
        {t('settings.error')}{' '}
        <button type="button" onClick={() => void settings.refetch()} className="underline">
          {t('common.retry')}
        </button>
      </p>
    );
  }

  return (
    <div>
      <PageHeader title={t('settings.title')} />
      <div className="space-y-5">
        <AppearancePanel />
        <SecurityPanel />
        <AlertsPanel settings={settings.data} t={t} />
        <RedditPanel settings={settings.data} t={t} />
        <NitterPanel settings={settings.data} t={t} />
        <RetentionPanel settings={settings.data} t={t} />
      </div>
    </div>
  );
}
