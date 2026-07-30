/**
 * The top bar (04-SPEC-frontend.md 2): view title, search, refresh, theme toggle.
 *
 * The edit-mode toggle arrives in Phase 5, when there is a grid to edit.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useT } from '../i18n.tsx';
import { useUiStore } from '../stores/ui.ts';
import { useThemeStore } from '../theme/store.ts';

const TITLE_KEYS: Record<string, string> = {
  '/reader': 'reader.title',
  '/sources': 'sources.title',
  '/tags': 'tags.title',
  '/rules': 'rules.title',
  '/settings': 'settings.title',
};

export function TopBar(): ReactNode {
  const t = useT();
  const location = useLocation();
  const search = useUiStore((state) => state.search);
  const setSearch = useUiStore((state) => state.setSearch);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleShortcuts = useUiStore((state) => state.toggleShortcuts);
  const requestRefresh = useUiStore((state) => state.requestRefresh);
  const focusRequests = useUiStore((state) => state.searchFocusRequests);

  const mode = useThemeStore((state) => state.mode);
  const resolved = useThemeStore((state) => state.resolved);
  const setMode = useThemeStore((state) => state.setMode);

  const searchInput = useRef<HTMLInputElement>(null);

  // The `/` shortcut asks for focus by incrementing a counter.
  const seenRequests = useRef(focusRequests);
  useEffect(() => {
    // Only react to a request made *after* this bar mounted. Otherwise a request
    // left over from earlier would steal focus the moment the bar reappears.
    if (focusRequests === seenRequests.current) return;
    seenRequests.current = focusRequests;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [focusRequests]);

  const titleKey = TITLE_KEYS[location.pathname] ?? 'app.name';

  return (
    <header className="bg-surface border-subtle sticky top-0 z-20 flex items-center gap-2 border-b px-3 py-2">
      <button
        type="button"
        onClick={toggleSidebar}
        className="text-secondary hover:bg-hovered rounded px-2 py-1 lg:hidden"
        aria-label={t('nav.open')}
      >
        ☰
      </button>

      <h1 className="text-primary mr-auto text-sm font-semibold">{t(titleKey)}</h1>

      <label className="sr-only" htmlFor="global-search">
        {t('topbar.search')}
      </label>
      <input
        id="global-search"
        ref={searchInput}
        type="search"
        value={search}
        placeholder={t('topbar.search')}
        onChange={(event) => setSearch(event.target.value)}
        className="w-32 text-sm sm:w-56"
      />

      <button
        type="button"
        onClick={requestRefresh}
        className="text-secondary hover:bg-hovered rounded px-2 py-1 text-sm"
        title={t('topbar.refresh')}
        aria-label={t('topbar.refresh')}
      >
        ↻
      </button>

      <button
        type="button"
        // Cycles rather than flipping: `system` is a real choice and has to be
        // reachable without opening settings.
        onClick={() => setMode(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system')}
        className="text-secondary hover:bg-hovered rounded px-2 py-1 text-sm"
        title={t(`theme.mode.${mode}`)}
        aria-label={t('topbar.theme', { mode: t(`theme.mode.${mode}`) })}
      >
        {mode === 'system' ? '◐' : resolved === 'dark' ? '☾' : '☀'}
      </button>

      <button
        type="button"
        onClick={toggleShortcuts}
        className="text-secondary hover:bg-hovered hidden rounded px-2 py-1 text-sm sm:block"
        title={t('shortcuts.title')}
        aria-label={t('shortcuts.title')}
      >
        ?
      </button>
    </header>
  );
}
