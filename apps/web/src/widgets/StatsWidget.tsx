/**
 * The `stats` widget (04-SPEC-frontend.md 4.5).
 *
 * Items ingested today and this week, unread count, top sources by volume, and the
 * Reddit budget gauge.
 */

import { memo, type ReactNode } from 'react';
import type { StatsWidgetConfig, StatsWidgetData } from '@nexuscentral/shared';
import { useT } from '../i18n.tsx';
import { formatNumber } from '../lib/format.ts';
import type { WidgetBodyProps, WidgetConfigFormProps } from './registry.tsx';

function Figure({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <dt className="text-muted text-xs">{label}</dt>
      <dd className="text-primary text-lg tabular-nums">{value}</dd>
    </div>
  );
}

export const StatsWidget = memo(function StatsWidget({ config, data }: WidgetBodyProps): ReactNode {
  const t = useT();
  const typed = config as unknown as StatsWidgetConfig;
  const payload = data as StatsWidgetData | undefined;

  if (payload === undefined) return null;

  const utilisation = payload.reddit.utilisation;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3">
        <Figure label={t('widget.stats.today')} value={formatNumber(payload.itemsToday)} />
        <Figure label={t('widget.stats.thisWeek')} value={formatNumber(payload.itemsThisWeek)} />
        <Figure label={t('widget.stats.unread')} value={formatNumber(payload.unread)} />
        <Figure label={t('widget.stats.starred')} value={formatNumber(payload.starred)} />
      </dl>

      {payload.topSources.length > 0 && (
        <div>
          <p className="text-muted mb-1 text-xs">{t('widget.stats.topSources')}</p>
          <ul className="space-y-0.5">
            {payload.topSources.map((source) => (
              <li key={source.id} className="flex justify-between gap-2 text-xs">
                <span className="text-secondary truncate">{source.title}</span>
                <span className="text-muted tabular-nums">{formatNumber(source.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {typed.showRedditBudget && (
        <div>
          <p className="text-muted mb-1 text-xs">{t('widget.stats.redditBudget')}</p>
          {!payload.reddit.configured ? (
            <p className="text-muted text-xs">{t('widget.stats.redditNotConfigured')}</p>
          ) : utilisation === null ? (
            // Configured but never polled: the headers are the only source of
            // truth for this number, so there is nothing honest to draw yet.
            <p className="text-muted text-xs">{t('widget.stats.redditNoData')}</p>
          ) : (
            <>
              <div
                className="bg-raised h-2 w-full overflow-hidden rounded"
                role="meter"
                aria-valuenow={Math.round(utilisation * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('widget.stats.redditBudget')}
              >
                <div
                  // The cap is half the window, so the bar is scaled to that: a
                  // gauge that never passes 8% would tell you nothing.
                  className={utilisation > 0.4 ? 'bg-warning h-full' : 'bg-positive h-full'}
                  style={{ width: `${Math.min(100, (utilisation / 0.5) * 100)}%` }}
                />
              </div>
              <p className="text-muted mt-1 text-xs">
                {t('widget.stats.redditRemaining', {
                  remaining: formatNumber(payload.reddit.remaining ?? 0),
                  limit: formatNumber(payload.reddit.limit ?? 0),
                })}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
});

export function StatsConfigForm({ value, onChange }: WidgetConfigFormProps): ReactNode {
  const t = useT();
  const config = value as unknown as StatsWidgetConfig;

  return (
    <div className="space-y-3 text-sm">
      <label className="text-secondary flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={config.showRedditBudget}
          onChange={(event) => onChange({ ...value, showRedditBudget: event.target.checked })}
        />
        {t('widget.stats.showRedditBudget')}
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.stats.topSourceCount')}</span>
        <input
          type="number"
          min={1}
          max={20}
          value={config.topSourceCount}
          onChange={(event) => onChange({ ...value, topSourceCount: Number(event.target.value) })}
          className="ml-2 w-20"
        />
      </label>
    </div>
  );
}
