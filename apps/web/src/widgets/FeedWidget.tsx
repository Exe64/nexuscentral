/**
 * The `feed` widget (04-SPEC-frontend.md 4.1).
 *
 * The core widget, and what makes the tag system pay off. Each row shows the title
 * with visited styling, the source, a relative time, engagement where present, and
 * the score as a subtle badge.
 */

import { memo, useState, type ReactNode } from 'react';
import {
  ITEM_SORTS,
  type FeedWidgetConfig,
  type FeedWidgetData,
  type Item,
} from '@nexuscentral/shared';
import { useTags } from '../api/queries.ts';
import { TagChip } from '../components/TagChip.tsx';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, formatNumber, relativeTime } from '../lib/format.ts';
import type { WidgetBodyProps, WidgetConfigFormProps } from './registry.tsx';

function Row({
  item,
  config,
  t,
}: {
  item: Item;
  config: FeedWidgetConfig;
  t: Translate;
}): ReactNode {
  const isRead = item.readAt !== null;
  const compact = config.density === 'compact';

  return (
    <li className={compact ? 'py-1' : 'py-1.5'}>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        className={`block text-sm leading-snug ${isRead ? 'text-visited' : 'text-primary hover:text-accent'}`}
      >
        {item.title}
      </a>
      <p className="text-muted mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
        {config.showSource && <span>{item.source.title}</span>}
        <time dateTime={item.publishedAt} title={absoluteTime(item.publishedAt)}>
          {relativeTime(item.publishedAt)}
        </time>
        {item.engagementScore !== null && (
          <span>{t('reader.item.points', { count: formatNumber(item.engagementScore) })}</span>
        )}
        <span className="border-subtle rounded border px-1 tabular-nums">
          {item.score.toFixed(1)}
        </span>
        {!compact && item.source.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
      </p>
    </li>
  );
}

export const FeedWidget = memo(function FeedWidget({ config, data }: WidgetBodyProps): ReactNode {
  const t = useT();
  const typed = config as unknown as FeedWidgetConfig;
  const payload = data as FeedWidgetData | undefined;
  const [expanded, setExpanded] = useState(false);

  if (payload === undefined || payload.items.length === 0) {
    return (
      <p className="text-secondary text-sm">
        {typed.unreadOnly ? t('reader.emptyAllRead') : t('widget.feed.empty')}
      </p>
    );
  }

  // `collapseAfter` is the single best idea in Glance's design: it stops one chatty
  // source from burying every other widget on the page.
  const limit = typed.collapseAfter;
  const collapsed = limit !== null && !expanded && payload.items.length > limit;
  const visible = collapsed ? payload.items.slice(0, limit) : payload.items;

  return (
    <>
      <ul className="divide-subtle divide-y">
        {visible.map((item) => (
          <Row key={item.id} item={item} config={typed} t={t} />
        ))}
      </ul>

      {collapsed && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-accent mt-2 text-xs hover:underline"
        >
          {t('widget.feed.showMore', { count: payload.items.length - visible.length })}
        </button>
      )}

      {payload.total > payload.items.length && (
        <p className="text-muted mt-2 text-xs">
          {t('widget.feed.showing', {
            shown: formatNumber(payload.items.length),
            total: formatNumber(payload.total),
          })}
        </p>
      )}
    </>
  );
});

export function FeedConfigForm({ value, onChange }: WidgetConfigFormProps): ReactNode {
  const t = useT();
  const tags = useTags();
  const config = value as unknown as FeedWidgetConfig;

  const set = (patch: Partial<FeedWidgetConfig>): void =>
    onChange({ ...value, ...patch } as Record<string, unknown>);

  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-secondary">{t('reader.sort.label')}</span>
        <select
          value={config.sort}
          onChange={(event) => set({ sort: event.target.value as FeedWidgetConfig['sort'] })}
          className="ml-2"
        >
          {ITEM_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {t(`reader.sort.${sort}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.feed.limit')}</span>
        <input
          type="number"
          min={1}
          max={50}
          value={config.limit}
          onChange={(event) => set({ limit: Number(event.target.value) })}
          className="ml-2 w-20"
        />
      </label>

      <label className="block">
        <span className="text-secondary">{t('widget.feed.collapseAfter')}</span>
        <input
          type="number"
          min={1}
          max={50}
          value={config.collapseAfter ?? ''}
          placeholder={t('widget.feed.collapseAfter.off')}
          onChange={(event) =>
            set({ collapseAfter: event.target.value === '' ? null : Number(event.target.value) })
          }
          className="ml-2 w-20"
        />
      </label>

      <label className="text-secondary flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={config.unreadOnly}
          onChange={(event) => set({ unreadOnly: event.target.checked })}
        />
        {t('reader.filter.unreadOnly')}
      </label>

      <label className="text-secondary flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={config.showSource}
          onChange={(event) => set({ showSource: event.target.checked })}
        />
        {t('widget.feed.showSource')}
      </label>

      <label className="text-secondary flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={config.density === 'compact'}
          onChange={(event) => set({ density: event.target.checked ? 'compact' : 'comfortable' })}
        />
        {t('widget.feed.compact')}
      </label>

      {(tags.data ?? []).length > 0 && (
        <fieldset>
          <legend className="text-secondary">{t('widget.feed.tagFilter')}</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {(tags.data ?? []).map((tag) => (
              <label key={tag.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={config.tagIds.includes(tag.id)}
                  onChange={(event) =>
                    set({
                      tagIds: event.target.checked
                        ? [...config.tagIds, tag.id]
                        : config.tagIds.filter((id) => id !== tag.id),
                    })
                  }
                />
                <TagChip tag={tag} />
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}
