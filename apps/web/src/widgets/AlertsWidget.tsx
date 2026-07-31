/**
 * The `alerts` widget (04-SPEC-frontend.md 4.3).
 *
 * Unacknowledged alerts, newest first, with the matched rule name and an ack button.
 */

import { memo, type ReactNode } from 'react';
import type { AlertsWidgetConfig, AlertsWidgetData } from '@nexuscentral/shared';
import { useAcknowledgeAlert } from '../api/queries.ts';
import { useT } from '../i18n.tsx';
import { absoluteTime, relativeTime } from '../lib/format.ts';
import type { WidgetBodyProps, WidgetConfigFormProps } from './registry.tsx';

export const AlertsWidget = memo(function AlertsWidget({ data }: WidgetBodyProps): ReactNode {
  const t = useT();
  const acknowledge = useAcknowledgeAlert();
  const payload = data as AlertsWidgetData | undefined;

  if (payload === undefined || payload.alerts.length === 0) {
    // An invitation, not a blank box.
    return <p className="text-secondary text-sm">{t('widget.alerts.empty')}</p>;
  }

  return (
    <ul className="divide-subtle divide-y">
      {payload.alerts.map((alert) => (
        <li key={alert.id} className="flex items-start gap-2 py-1.5">
          <div className="min-w-0 flex-1">
            <a
              href={alert.item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:text-accent block text-sm leading-snug"
            >
              {alert.item.title}
            </a>
            <p className="text-muted mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
              <span className="text-warning">{alert.rule.name}</span>
              <span>{alert.item.source.title}</span>
              <time dateTime={alert.createdAt} title={absoluteTime(alert.createdAt)}>
                {relativeTime(alert.createdAt)}
              </time>
              {/* Delivery is Phase 6; until then every alert is in-app only, and
                  saying so beats an unexplained blank. */}
              {alert.deliveryError !== null && (
                <span className="text-negative">{t('widget.alerts.deliveryFailed')}</span>
              )}
            </p>
          </div>
          {alert.acknowledgedAt === null && (
            <button
              type="button"
              disabled={acknowledge.isPending}
              onClick={() => acknowledge.mutate(alert.id)}
              className="border-subtle text-secondary hover:bg-hovered shrink-0 rounded border px-1.5 py-0.5 text-xs"
            >
              {t('widget.alerts.ack')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
});

export function AlertsConfigForm({ value, onChange }: WidgetConfigFormProps): ReactNode {
  const t = useT();
  const config = value as unknown as AlertsWidgetConfig;

  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-secondary">{t('widget.alerts.limit')}</span>
        <input
          type="number"
          min={1}
          max={50}
          value={config.limit}
          onChange={(event) => onChange({ ...value, limit: Number(event.target.value) })}
          className="ml-2 w-20"
        />
      </label>

      <label className="text-secondary flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={config.includeAcknowledged}
          onChange={(event) => onChange({ ...value, includeAcknowledged: event.target.checked })}
        />
        {t('widget.alerts.includeAcknowledged')}
      </label>
    </div>
  );
}
