/**
 * `/reader` -- the full-height item list with filters (04-SPEC-frontend.md 1).
 *
 * Plain and unstyled by design: Phase 1 proves the data path end to end, Phase 4
 * brings the theme tokens and Phase 5 the dashboard grid.
 */

import { useMemo, useState, type ReactNode } from 'react';
import type { Item, ItemSort } from '@feedhub/shared';
import {
  useItems,
  useMarkAllRead,
  useSetItemRead,
  useSetItemStarred,
  useSources,
  useTags,
  type ItemListFilters,
} from '../api/queries.ts';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, relativeTime } from '../lib/format.ts';

const SORTS: ItemSort[] = ['published', 'score', 'engagement'];

function ItemRow({
  item,
  t,
  onToggleRead,
  onToggleStar,
}: {
  item: Item;
  t: Translate;
  onToggleRead: (item: Item) => void;
  onToggleStar: (item: Item) => void;
}): ReactNode {
  const isRead = item.readAt !== null;

  return (
    <li>
      <article>
        <h3>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            // Opening an item marks it read: that is what "read" means here.
            onClick={() => {
              if (!isRead) onToggleRead(item);
            }}
          >
            {item.title}
          </a>
        </h3>

        <p>
          <span>{item.source.title}</span>
          {' · '}
          <time dateTime={item.publishedAt} title={absoluteTime(item.publishedAt)}>
            {relativeTime(item.publishedAt)}
          </time>
          {item.engagementScore !== null && <span>{` · ${item.engagementScore} points`}</span>}
          <span>{` · ${item.score.toFixed(2)}`}</span>
          {item.source.tags.length > 0 && (
            <span>{` · ${item.source.tags.map((tag) => tag.name).join(', ')}`}</span>
          )}
        </p>

        {item.summary !== null && <p>{item.summary}</p>}

        <p>
          <button type="button" onClick={() => onToggleRead(item)}>
            {isRead ? t('reader.item.markUnread') : t('reader.item.markRead')}
          </button>{' '}
          <button type="button" onClick={() => onToggleStar(item)}>
            {item.starred ? t('reader.item.unstar') : t('reader.item.star')}
          </button>
        </p>
      </article>
    </li>
  );
}

export function Reader(): ReactNode {
  const t = useT();

  const [q, setQ] = useState('');
  const [sort, setSort] = useState<ItemSort>('published');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [tagId, setTagId] = useState<number | null>(null);

  const tags = useTags();
  const sources = useSources();

  // The filter object is the query key, so a new object identity on every render
  // would refetch on every keystroke of an unrelated input.
  const filters = useMemo<ItemListFilters>(
    () => ({
      ...(q.trim() === '' ? {} : { q: q.trim() }),
      sort,
      ...(unreadOnly ? { unreadOnly: true } : {}),
      ...(starredOnly ? { starredOnly: true } : {}),
      ...(tagId === null ? {} : { tagIds: [tagId] }),
      limit: 50,
    }),
    [q, sort, unreadOnly, starredOnly, tagId],
  );

  const items = useItems(filters);
  const setRead = useSetItemRead();
  const setStarred = useSetItemStarred();
  const markAllRead = useMarkAllRead();

  const rows = useMemo(() => items.data?.pages.flatMap((page) => page.data) ?? [], [items.data]);

  const emptyMessage = (): string => {
    if (sources.data !== undefined && sources.data.length === 0) return t('reader.emptyNoSources');
    if (unreadOnly) return t('reader.emptyAllRead');
    return t('reader.empty');
  };

  return (
    <section>
      <h2>{t('reader.title')}</h2>

      <form
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label>
          {t('reader.search.placeholder')}
          <input
            type="search"
            value={q}
            placeholder={t('reader.search.placeholder')}
            onChange={(event) => setQ(event.target.value)}
          />
        </label>

        <label>
          {t('reader.sort.label')}
          <select value={sort} onChange={(event) => setSort(event.target.value as ItemSort)}>
            {SORTS.map((option) => (
              <option key={option} value={option}>
                {t(`reader.sort.${option}`)}
              </option>
            ))}
          </select>
        </label>

        <label>
          {t('reader.filter.allTags')}
          <select
            value={tagId ?? ''}
            onChange={(event) =>
              setTagId(event.target.value === '' ? null : Number(event.target.value))
            }
          >
            <option value="">{t('reader.filter.allTags')}</option>
            {(tags.data ?? []).map((tag) => (
              <option key={tag.id} value={tag.id}>
                {`${tag.name} (${tag.unreadCount})`}
              </option>
            ))}
          </select>
        </label>

        <label>
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          {t('reader.filter.unreadOnly')}
        </label>

        <label>
          <input
            type="checkbox"
            checked={starredOnly}
            onChange={(event) => setStarredOnly(event.target.checked)}
          />
          {t('reader.filter.starredOnly')}
        </label>

        <button
          type="button"
          disabled={markAllRead.isPending || rows.length === 0}
          onClick={() => markAllRead.mutate(filters)}
        >
          {t('reader.markAllRead')}
        </button>
      </form>

      {markAllRead.data !== undefined && (
        <p role="status">{t('reader.markedAllRead', { count: markAllRead.data.updated })}</p>
      )}

      {items.isPending && <p>{t('common.loading')}</p>}

      {items.error !== null && (
        <p role="alert">
          {t('reader.error')}{' '}
          <button type="button" onClick={() => void items.refetch()}>
            {t('common.retry')}
          </button>
        </p>
      )}

      {!items.isPending && items.error === null && rows.length === 0 && <p>{emptyMessage()}</p>}

      <ul>
        {rows.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            t={t}
            onToggleRead={(target) =>
              setRead.mutate({ id: target.id, read: target.readAt === null })
            }
            onToggleStar={(target) =>
              setStarred.mutate({ id: target.id, starred: !target.starred })
            }
          />
        ))}
      </ul>

      {items.hasNextPage === true && (
        <button
          type="button"
          disabled={items.isFetchingNextPage}
          onClick={() => void items.fetchNextPage()}
        >
          {items.isFetchingNextPage ? t('common.loading') : t('reader.loadMore')}
        </button>
      )}
    </section>
  );
}
