/**
 * Where alerts get pushed to, and a button that actually pushes one.
 *
 * The test button matters more than it looks: a webhook URL is the kind of thing
 * that is wrong in a way nothing tells you about until the one alert you cared
 * about fails to arrive.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { WEBHOOK_KINDS, type Settings, type WebhookKind } from '@nexuscentral/shared';
import { useTestWebhook, useUpdateSettings } from '../api/queries.ts';
import type { Translate } from '../i18n.tsx';

/** What to paste, per target. Generic enough to be true, specific enough to help. */
const PLACEHOLDER: Record<Exclude<WebhookKind, 'none'>, string> = {
  ntfy: 'https://ntfy.sh/your-topic-name',
  gotify: 'https://gotify.example.com/message?token=YOUR_TOKEN',
  discord: 'https://discord.com/api/webhooks/…',
  generic: 'https://example.com/your-endpoint',
};

export function AlertsPanel({ settings, t }: { settings: Settings; t: Translate }): ReactNode {
  const update = useUpdateSettings();
  const test = useTestWebhook();

  const [kind, setKind] = useState<WebhookKind>(settings.alertWebhookKind);
  const [url, setUrl] = useState(settings.alertWebhookUrl ?? '');
  const [saved, setSaved] = useState(false);

  const needsUrl = kind !== 'none' && url.trim() === '';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (needsUrl || update.isPending) return;
    update.mutate(
      { alertWebhookKind: kind, alertWebhookUrl: kind === 'none' ? null : url.trim() },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <section className="space-y-3">
      <h2 className="text-primary text-base font-semibold">{t('settings.alerts.title')}</h2>
      <p className="text-secondary max-w-prose text-sm">{t('settings.alerts.intro')}</p>

      <form onSubmit={submit} className="max-w-prose space-y-3 text-sm">
        <div>
          <label htmlFor="alert-kind" className="text-secondary block">
            {t('settings.alerts.kind')}
          </label>
          <select
            id="alert-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as WebhookKind);
              setSaved(false);
            }}
            className="mt-1"
          >
            {WEBHOOK_KINDS.map((option) => (
              <option key={option} value={option}>
                {t(`settings.alerts.kind.${option}`)}
              </option>
            ))}
          </select>
        </div>

        {kind !== 'none' && (
          <div>
            <label htmlFor="alert-url" className="text-secondary block">
              {t('settings.alerts.url')}
            </label>
            <input
              id="alert-url"
              type="url"
              value={url}
              placeholder={PLACEHOLDER[kind]}
              onChange={(event) => {
                setUrl(event.target.value);
                setSaved(false);
              }}
              className="mt-1 block w-full"
              aria-describedby="alert-url-hint"
            />
            <p id="alert-url-hint" className="text-muted mt-1 text-xs">
              {t(`settings.alerts.hint.${kind}`)}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={needsUrl || update.isPending}
            className="bg-accent text-accent-fg rounded px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {update.isPending ? t('settings.alerts.saving') : t('settings.alerts.save')}
          </button>

          {settings.alertWebhookKind !== 'none' && (
            <button
              type="button"
              onClick={() => test.mutate()}
              disabled={test.isPending}
              className="border-subtle text-secondary hover:bg-hovered rounded border px-3 py-1.5 text-sm"
            >
              {test.isPending ? t('settings.alerts.testing') : t('settings.alerts.test')}
            </button>
          )}
        </div>

        {saved && !update.isPending && (
          <p role="status" className="text-positive text-xs">
            {t('settings.saved')}
          </p>
        )}
        {update.error !== null && (
          <p role="alert" className="text-negative text-xs">
            {update.error.message}
          </p>
        )}

        {test.data !== undefined && (
          <p
            role="status"
            className={test.data.ok ? 'text-positive text-xs' : 'text-negative text-xs'}
          >
            {test.data.ok
              ? t('settings.alerts.testOk')
              : t('settings.alerts.testFailed', { message: test.data.message ?? '' })}
          </p>
        )}
        {test.error !== null && (
          <p role="alert" className="text-negative text-xs">
            {t('settings.alerts.testFailed', { message: test.error.message })}
          </p>
        )}
      </form>

      {settings.alertWebhookKind === 'none' && (
        <p className="text-muted max-w-prose text-xs">{t('settings.alerts.noneNote')}</p>
      )}
    </section>
  );
}
