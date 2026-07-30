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
import type { Settings as SettingsShape } from '@feedhub/shared';
import { useSettings, useTestNitter, useTestReddit, useUpdateSettings } from '../api/queries.ts';
import { AppearancePanel } from '../components/AppearancePanel.tsx';
import { useT, type Translate } from '../i18n.tsx';

function RedditPanel({ settings, t }: { settings: SettingsShape; t: Translate }): ReactNode {
  const update = useUpdateSettings();
  const test = useTestReddit();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  return (
    <section>
      <h3>{t('settings.reddit.title')}</h3>
      <p>{t('settings.reddit.intro')}</p>

      {settings.reddit.configured ? (
        <p role="status">
          {t('settings.reddit.configured', { origin: settings.reddit.origin ?? 'settings' })}
        </p>
      ) : (
        <p role="status">{t('settings.reddit.notConfigured')}</p>
      )}

      {settings.reddit.envOverridesSettings && (
        // Saying this out loud, because otherwise saving the form looks like a
        // no-op and the user has no way to tell why.
        <p role="alert">{t('settings.reddit.envOverrides')}</p>
      )}

      <form
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
        <label htmlFor="reddit-client-id">{t('settings.reddit.clientId')}</label>
        <input
          id="reddit-client-id"
          value={clientId}
          autoComplete="off"
          onChange={(event) => setClientId(event.target.value)}
        />

        <label htmlFor="reddit-client-secret">{t('settings.reddit.clientSecret')}</label>
        <input
          id="reddit-client-secret"
          type="password"
          value={clientSecret}
          autoComplete="new-password"
          placeholder={t('settings.reddit.secretPlaceholder')}
          onChange={(event) => setClientSecret(event.target.value)}
        />

        <button type="submit" disabled={update.isPending}>
          {t('common.save')}
        </button>
      </form>

      <button
        type="button"
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
      </button>

      <button type="button" disabled={test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? t('settings.reddit.testing') : t('settings.reddit.test')}
      </button>

      {test.data !== undefined &&
        (test.data.ok ? (
          <div role="status">
            <p>{t('settings.reddit.testOk', { origin: test.data.origin ?? 'settings' })}</p>
            {test.data.budget?.remaining !== null && test.data.budget !== undefined && (
              <p>
                {t('settings.reddit.budget', {
                  remaining: test.data.budget.remaining ?? 0,
                  resetIn: test.data.budget.resetIn ?? 0,
                })}
              </p>
            )}
          </div>
        ) : (
          <p role="alert">
            {t('settings.reddit.testFailed', { message: test.data.message ?? '' })}
          </p>
        ))}

      {update.error !== null && (
        <p role="alert">{t('error.generic', { message: update.error.message })}</p>
      )}
      {update.isSuccess && <p role="status">{t('settings.saved')}</p>}
    </section>
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
    <section>
      <h3>{t('settings.nitter.title')}</h3>
      <p>{t('settings.nitter.intro')}</p>

      {settings.nitterBaseUrls.length === 0 ? (
        <p role="status">{t('settings.nitter.none')}</p>
      ) : (
        <p role="status">
          {settings.nitterBaseUrlsOrigin === 'env'
            ? t('settings.nitter.usingEnv')
            : t('settings.nitter.usingSettings')}
        </p>
      )}

      <form
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
        <label htmlFor="nitter-urls">{t('settings.nitter.urls')}</label>
        <textarea
          id="nitter-urls"
          value={text}
          rows={4}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" disabled={update.isPending}>
          {t('common.save')}
        </button>
      </form>

      <button type="button" disabled={test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? t('settings.nitter.testing') : t('settings.nitter.test')}
      </button>

      {test.data !== undefined && (
        <>
          {!test.data.ok && test.data.instances.length > 0 && (
            <p role="alert">{t('settings.nitter.allFailed')}</p>
          )}
          <ul>
            {test.data.instances.map((instance) => (
              <li key={instance.baseUrl}>
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
        </>
      )}
    </section>
  );
}

function RetentionPanel({ settings, t }: { settings: SettingsShape; t: Translate }): ReactNode {
  const update = useUpdateSettings();
  const [days, setDays] = useState(String(settings.itemsRetentionDays));

  return (
    <section>
      <h3>{t('settings.retention.title')}</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = Number(days);
          if (!Number.isInteger(parsed) || parsed < 1) return;
          update.mutate({ itemsRetentionDays: parsed });
        }}
      >
        <label htmlFor="retention-days">{t('settings.retention.days')}</label>
        <input
          id="retention-days"
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
        <button type="submit" disabled={update.isPending}>
          {t('common.save')}
        </button>
      </form>
    </section>
  );
}

export function Settings(): ReactNode {
  const t = useT();
  const settings = useSettings();

  if (settings.isPending) return <p>{t('common.loading')}</p>;

  if (settings.error !== null) {
    return (
      <p role="alert">
        {t('settings.error')}{' '}
        <button type="button" onClick={() => void settings.refetch()}>
          {t('common.retry')}
        </button>
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <AppearancePanel />
      <RedditPanel settings={settings.data} t={t} />
      <NitterPanel settings={settings.data} t={t} />
      <RetentionPanel settings={settings.data} t={t} />
    </div>
  );
}
