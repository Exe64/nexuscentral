/**
 * The `source_health` widget (04-SPEC-frontend.md 4.4).
 *
 * Sources with failures or repeated empty polls, with the last error and a
 * "Poll now" button. The empty state is "All sources healthy." -- that is a
 * feature, not a blank box.
 */

import { memo, type ReactNode } from 'react';
import type {
  Source,
  SourceHealthWidgetConfig,
  SourceHealthWidgetData,
} from '@nexuscentral/shared';
import { usePollSource } from '../api/queries.ts';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, relativeTime } from '../lib/format.ts';
import type { WidgetBodyProps, WidgetConfigFormProps } from './registry.tsx';

function status(source: Source, t: Translate): { label: string; tone: string } {
  if (!source.active) return { label: t('sources.health.inactive'), tone: 'text-muted' };
  if (source.health.consecutiveFailures > 0) {
    return {
      label: t('sources.health.failing', { count: source.health.consecutiveFailures }),
      tone: 'text-negative',
    };
  }
  if (source.health.consecutiveEmpty > 0) {
    // Counted separately because nothing about those runs looked like an error.
    return {
      label: t('sources.health.empty', { count: source.health.consecutiveEmpty }),
      tone: 'text-warning',
    };
  }
  return { label: t('sources.health.ok'), tone: 'text-positive' };
}

export const SourceHealthWidget = memo(function SourceHealthWidget({
  data,
}: WidgetBodyProps): ReactNode {
  const t = useT();
  const poll = usePollSource();
  const payload = data as SourceHealthWidgetData | undefined;

  if (payload === undefined) return null;

  if (payload.sources.length === 0) {
    return (
      <p className="text-positive text-sm">
        {payload.total === 0 ? t('sources.empty') : t('widget.sourceHealth.allHealthy')}
      </p>
    );
  }

  return (
    <ul className="divide-subtle divide-y">
      {payload.sources.map((source) => {
        const state = status(source, t);
        return (
          <li key={source.id} className="flex items-start gap-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="text-primary truncate text-sm">{source.title}</p>
              <p className="text-muted mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
                <span className={state.tone}>{state.label}</span>
                {source.health.lastOkAt !== null && (
                  <time
                    dateTime={source.health.lastOkAt}
                    title={absoluteTime(source.health.lastOkAt)}
                  >
                    {relativeTime(source.health.lastOkAt)}
                  </time>
                )}
              </p>
              {source.health.lastError !== null && (
                <p className="text-muted mt-0.5 truncate text-xs" title={source.health.lastError}>
                  {source.health.lastError}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={poll.isPending}
              onClick={() => poll.mutate(source.id)}
              className="border-subtle text-secondary hover:bg-hovered shrink-0 rounded border px-1.5 py-0.5 text-xs"
            >
              {t('sources.pollNow')}
            </button>
          </li>
        );
      })}
    </ul>
  );
});

export function SourceHealthConfigForm({ value, onChange }: WidgetConfigFormProps): ReactNode {
  const t = useT();
  const config = value as unknown as SourceHealthWidgetConfig;

  return (
    <div className="space-y-3 text-sm">
      <label className="text-secondary flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={config.showHealthy}
          onChange={(event) => onChange({ ...value, showHealthy: event.target.checked })}
        />
        {t('widget.sourceHealth.showHealthy')}
      </label>
    </div>
  );
}
