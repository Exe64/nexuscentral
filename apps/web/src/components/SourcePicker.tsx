/**
 * A multi-select over sources.
 *
 * Tags are a handful of chips and a row of checkboxes renders them fine. Sources
 * are not: the widget config allows up to 200, which is a wall of checkboxes in a
 * dialog that is `max-w-lg` wide. So this one is searchable and its list is
 * height-bounded.
 */

import { useState, type ReactNode } from 'react';
import type { Source } from '@nexuscentral/shared';
import { useT } from '../i18n.tsx';
import { SourceIcon } from './ui.tsx';
import { TagChip } from './TagChip.tsx';

/** Below this a search box is noise -- the whole list already fits on screen. */
const SEARCH_THRESHOLD = 8;

/**
 * Matches the title and the identifier, because either is what comes to mind:
 * a subreddit is `steamdeck` and an RSS feed's identifier carries its domain,
 * neither of which need be in a title the user may have renamed.
 *
 * The same pair the API's own `q` filter searches (`listSources`), so typing the
 * same words on the Sources page and in here finds the same sources. Filtering
 * happens client-side: the list is already loaded whole and unpaginated, and a
 * round trip per keystroke would be slower and no more correct.
 */
export function matchesQuery(source: Source, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    source.title.toLowerCase().includes(needle) || source.identifier.toLowerCase().includes(needle)
  );
}

export interface SourcePickerProps {
  sources: readonly Source[];
  selected: readonly number[];
  onChange: (next: number[]) => void;
}

export function SourcePicker({ sources, selected, onChange }: SourcePickerProps): ReactNode {
  const t = useT();
  const [query, setQuery] = useState('');

  const toggle = (id: number, checked: boolean): void => {
    onChange(checked ? [...selected, id] : selected.filter((each) => each !== id));
  };

  // A selected source stays visible whatever the search says. Otherwise you
  // filter on "reddit", tick three, filter on "blog", and the three you picked
  // are gone from the screen -- still selected, but neither reviewable nor
  // removable without reconstructing the search that found them.
  const visible = sources.filter(
    (source) => selected.includes(source.id) || matchesQuery(source, query),
  );

  return (
    <div>
      {sources.length > SEARCH_THRESHOLD && (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('sourcePicker.search')}
          aria-label={t('sourcePicker.search')}
          className="mb-1.5 block w-full text-sm"
        />
      )}

      <div className="border-subtle max-h-48 overflow-y-auto rounded border px-2 py-1.5">
        {visible.length === 0 ? (
          <p className="text-muted py-1 text-xs">{t('sourcePicker.noMatch', { query })}</p>
        ) : (
          <ul className="space-y-1">
            {visible.map((source) => (
              <li key={source.id}>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={selected.includes(source.id)}
                    onChange={(event) => toggle(source.id, event.target.checked)}
                  />
                  <SourceIcon src={source.iconUrl} />
                  {/* Its own element, so an exact-text query for the source name
                      keeps matching once the tags sit beside it. */}
                  <span className={source.active ? 'text-primary' : 'text-muted'}>
                    {source.title}
                  </span>
                  {!source.active && (
                    <span className="text-muted text-xs">{t('sources.health.inactive')}</span>
                  )}
                  {source.tags.map((tag) => (
                    <TagChip key={tag.id} tag={tag} />
                  ))}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected.length > 0 && (
        <p className="text-muted mt-1 flex items-center gap-2 text-xs">
          <span>{t('sourcePicker.selected', { count: selected.length })}</span>
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-accent hover:underline"
          >
            {t('sourcePicker.clear')}
          </button>
        </p>
      )}
    </div>
  );
}
