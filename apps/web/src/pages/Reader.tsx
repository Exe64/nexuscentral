/**
 * `/reader` -- the full-height item list with filters (04-SPEC-frontend.md 1).
 *
 * Fully keyboard-drivable: `j` and `k` move, `o` opens, `m` toggles read, `s`
 * stars. The focused row is a real focused element, not a styled div, so the
 * browser's own focus ring and screen-reader behaviour come for free.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { READER_VIEWS, type Item, type ItemSort, type ReaderView } from '@nexuscentral/shared';
import {
  useItems,
  useMarkAllRead,
  useSetItemRead,
  useSetItemStarred,
  useSettings,
  useSources,
  useTags,
  useUpdateSettings,
  type ItemListFilters,
} from '../api/queries.ts';
import { ScoreBreakdown } from '../components/ScoreBreakdown.tsx';
import { TagChip } from '../components/TagChip.tsx';
import { Thumbnail } from '../components/ui.tsx';
import { useKeyboardShortcuts, type ShortcutMap } from '../hooks/useKeyboardShortcuts.ts';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, formatNumber, relativeTime } from '../lib/format.ts';
import { useUiStore } from '../stores/ui.ts';

const SORTS: ItemSort[] = ['published', 'score', 'engagement'];

/**
 * One item, in whichever layout the reader is set to.
 *
 * One component rather than three: the focus handling, the open-marks-read
 * behaviour and the breakdown popover are the bulk of it and are identical in
 * every mode. Only the body differs, and it differs in ways worth stating --
 * `titles` deliberately drops the summary and the action buttons, because a mode
 * whose whole point is density does not get to keep the furniture.
 */
function ItemRow({
  item,
  index,
  view,
  focused,
  t,
  onFocus,
  onToggleRead,
  onToggleStar,
  registerRef,
}: {
  item: Item;
  index: number;
  view: ReaderView;
  focused: boolean;
  t: Translate;
  onFocus: (index: number) => void;
  onToggleRead: (item: Item) => void;
  onToggleStar: (item: Item) => void;
  registerRef: (index: number, element: HTMLLIElement | null) => void;
}): ReactNode {
  const isRead = item.readAt !== null;
  const [explaining, setExplaining] = useState(false);
  const dense = view === 'titles';

  const titleLink = (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer noopener"
      className={isRead ? 'text-visited' : 'text-primary hover:text-accent'}
      // Opening an item marks it read: that is what "read" means here.
      onClick={() => {
        if (!isRead) onToggleRead(item);
      }}
    >
      {item.title}
    </a>
  );

  const scoreButton = (
    /* The score badge opens the explanation; that is how a rule set gets debugged. */
    <button
      type="button"
      aria-label={t('breakdown.open')}
      onClick={() => setExplaining((open) => !open)}
      className="border-subtle text-muted hover:text-primary rounded border px-1 tabular-nums"
    >
      {item.score.toFixed(2)}
    </button>
  );

  return (
    <li
      ref={(element) => registerRef(index, element)}
      tabIndex={focused ? 0 : -1}
      onFocus={() => onFocus(index)}
      aria-current={focused ? 'true' : undefined}
      className={[
        'border-subtle border-b last:border-b-0',
        dense ? 'px-2 py-1' : 'px-2 py-2.5',
        focused ? 'bg-accent-subtle' : 'hover:bg-hovered',
      ].join(' ')}
    >
      {dense ? (
        <div className="flex items-baseline gap-2">
          <h3 className="mr-auto truncate text-sm leading-snug">{titleLink}</h3>
          {item.starred && <span aria-label={t('reader.item.starred')}>★</span>}
          <span className="text-muted shrink-0 text-xs">{item.source.title}</span>
          <span className="shrink-0 text-xs">{scoreButton}</span>
        </div>
      ) : (
        <div className={view === 'cards' ? 'flex gap-3' : undefined}>
          {view === 'cards' && item.imageUrl !== null && (
            // Fixed box, so the list does not reflow as thumbnails arrive.
            <div className="h-20 w-28 shrink-0 sm:h-24 sm:w-36">
              <Thumbnail src={item.imageUrl} />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h3 className="text-base leading-snug font-medium">{titleLink}</h3>

            <p className="text-secondary mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span>{item.source.title}</span>
              <time dateTime={item.publishedAt} title={absoluteTime(item.publishedAt)}>
                {relativeTime(item.publishedAt)}
              </time>
              {item.engagementScore !== null && (
                <span>
                  {t('reader.item.points', { count: formatNumber(item.engagementScore) })}
                </span>
              )}
              {scoreButton}
              {item.starred && <span aria-label={t('reader.item.starred')}>★</span>}
              {item.source.tags.map((tag) => (
                <TagChip key={tag.id} tag={tag} />
              ))}
            </p>

            {item.summary !== null && (
              <p
                className={`text-secondary mt-1.5 text-sm ${
                  // Two lines beside a thumbnail, three without: any more and the
                  // card grows taller than its own image.
                  view === 'cards' ? 'line-clamp-2' : 'line-clamp-3'
                }`}
              >
                {item.summary}
              </p>
            )}

            <p className="mt-2 flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => onToggleRead(item)}
                className="border-subtle text-secondary hover:bg-hovered rounded border px-2 py-0.5"
              >
                {isRead ? t('reader.item.markUnread') : t('reader.item.markRead')}
              </button>
              <button
                type="button"
                onClick={() => onToggleStar(item)}
                className="border-subtle text-secondary hover:bg-hovered rounded border px-2 py-0.5"
              >
                {item.starred ? t('reader.item.unstar') : t('reader.item.star')}
              </button>
            </p>
          </div>
        </div>
      )}

      {explaining && (
        <div className="bg-surface border-subtle mt-2 rounded border p-3 text-sm">
          <ScoreBreakdown
            itemId={item.id}
            storedScore={item.score}
            onClose={() => setExplaining(false)}
          />
        </div>
      )}
    </li>
  );
}

export function Reader(): ReactNode {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();

  const search = useUiStore((state) => state.search);
  const refreshRequests = useUiStore((state) => state.refreshRequests);

  const [sort, setSort] = useState<ItemSort>('published');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);

  // The tag filter lives in the URL so the sidebar can link to it and the view is
  // shareable and reloadable.
  const tagParam = searchParams.get('tag');
  const tagId = tagParam === null ? null : Number(tagParam);

  const tags = useTags();
  const sources = useSources();

  // The layout is a durable preference, so it lives in settings beside the theme
  // rather than in component state that a reload would throw away. Until the
  // fetch lands, render the mode the reader has always had.
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const view: ReaderView = settings.data?.readerView ?? 'list';

  const filters = useMemo<ItemListFilters>(
    () => ({
      ...(search.trim() === '' ? {} : { q: search.trim() }),
      sort,
      ...(unreadOnly ? { unreadOnly: true } : {}),
      ...(starredOnly ? { starredOnly: true } : {}),
      ...(tagId === null || Number.isNaN(tagId) ? {} : { tagIds: [tagId] }),
      limit: 50,
    }),
    [search, sort, unreadOnly, starredOnly, tagId],
  );

  const items = useItems(filters);
  const setRead = useSetItemRead();
  const setStarred = useSetItemStarred();
  const markAllRead = useMarkAllRead();

  const rows = useMemo(() => items.data?.pages.flatMap((page) => page.data) ?? [], [items.data]);

  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  const registerRef = useCallback((index: number, element: HTMLLIElement | null): void => {
    rowRefs.current[index] = element;
  }, []);

  const moveFocus = useCallback(
    (delta: number): void => {
      setFocusedIndex((current) => {
        const next = Math.min(rows.length - 1, Math.max(0, current + delta));
        // Focus the element itself so the browser scrolls it into view and screen
        // readers announce it.
        rowRefs.current[next]?.focus();
        return next;
      });
    },
    [rows.length],
  );

  // `r` in the top bar refetches whatever the current view is showing.
  useEffect(() => {
    if (refreshRequests === 0) return;
    void items.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRequests]);

  const shortcuts = useMemo<ShortcutMap>(() => {
    const current = rows[focusedIndex];
    return {
      j: () => moveFocus(1),
      k: () => moveFocus(-1),
      o: () => {
        if (current === undefined) return;
        window.open(current.url, '_blank', 'noreferrer,noopener');
        if (current.readAt === null) setRead.mutate({ id: current.id, read: true });
      },
      Enter: () => {
        if (current === undefined) return;
        window.open(current.url, '_blank', 'noreferrer,noopener');
        if (current.readAt === null) setRead.mutate({ id: current.id, read: true });
      },
      m: () => {
        if (current !== undefined)
          setRead.mutate({ id: current.id, read: current.readAt === null });
      },
      s: () => {
        if (current !== undefined) setStarred.mutate({ id: current.id, starred: !current.starred });
      },
    };
  }, [rows, focusedIndex, moveFocus, setRead, setStarred]);

  useKeyboardShortcuts(shortcuts);

  const emptyMessage = (): string => {
    if (sources.data !== undefined && sources.data.length === 0) return t('reader.emptyNoSources');
    if (unreadOnly) return t('reader.emptyAllRead');
    return t('reader.empty');
  };

  const activeTag = tags.data?.find((tag) => tag.id === tagId);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <span className="text-secondary">{t('reader.sort.label')}</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as ItemSort)}>
            {SORTS.map((option) => (
              <option key={option} value={option}>
                {t(`reader.sort.${option}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="text-secondary flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          {t('reader.filter.unreadOnly')}
        </label>

        <label className="text-secondary flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={starredOnly}
            onChange={(event) => setStarredOnly(event.target.checked)}
          />
          {t('reader.filter.starredOnly')}
        </label>

        {activeTag !== undefined && (
          <span className="flex items-center gap-1.5">
            <TagChip tag={activeTag} />
            <button
              type="button"
              onClick={() => setSearchParams({})}
              className="text-secondary hover:text-primary underline"
            >
              {t('reader.filter.clearTag')}
            </button>
          </span>
        )}

        {/* A segmented control, not a select: three options that are worth
            seeing at a glance, and `aria-pressed` says which one is on. */}
        <div
          role="group"
          aria-label={t('reader.view.label')}
          className="border-subtle ml-auto flex overflow-hidden rounded border"
        >
          {READER_VIEWS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              disabled={updateSettings.isPending}
              onClick={() => updateSettings.mutate({ readerView: option })}
              className={[
                'px-2 py-1 text-xs transition-colors disabled:opacity-60',
                view === option
                  ? 'bg-accent text-accent-fg'
                  : 'text-secondary hover:bg-hovered hover:text-primary',
              ].join(' ')}
            >
              {t(`reader.view.${option}`)}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={markAllRead.isPending || rows.length === 0}
          onClick={() => markAllRead.mutate(filters)}
          className="border-subtle text-secondary hover:bg-hovered rounded border px-2 py-1 disabled:opacity-50"
        >
          {t('reader.markAllRead')}
        </button>
      </div>

      {markAllRead.data !== undefined && (
        <p role="status" className="text-secondary mb-2 text-sm">
          {t('reader.markedAllRead', { count: markAllRead.data.updated })}
        </p>
      )}

      {items.isPending && <p className="text-secondary">{t('common.loading')}</p>}

      {items.error !== null && (
        <p role="alert" className="text-negative">
          {t('reader.error')}{' '}
          <button type="button" onClick={() => void items.refetch()} className="underline">
            {t('common.retry')}
          </button>
        </p>
      )}

      {!items.isPending && items.error === null && rows.length === 0 && (
        <p className="text-secondary">{emptyMessage()}</p>
      )}

      <ul className="bg-surface border-subtle divide-subtle rounded border">
        {rows.map((item, index) => (
          <ItemRow
            key={item.id}
            item={item}
            index={index}
            view={view}
            focused={index === focusedIndex}
            t={t}
            onFocus={setFocusedIndex}
            registerRef={registerRef}
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
          className="border-subtle text-secondary hover:bg-hovered mt-3 rounded border px-3 py-1.5 text-sm"
        >
          {items.isFetchingNextPage ? t('common.loading') : t('reader.loadMore')}
        </button>
      )}
    </section>
  );
}
