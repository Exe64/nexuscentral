/**
 * The application bar: the brand and the controls that belong to the app rather
 * than to any one page.
 *
 * Full width, above the sidebar. It carries the name, search, refresh, the theme
 * toggle and the shortcut list; the page's own name lives one bar down, in
 * `PageBar`. Splitting them means the brand stays put while navigating, which is
 * what makes the second bar readable as "where you are".
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n.tsx';
import { useUiStore } from '../stores/ui.ts';
import { useThemeStore } from '../theme/store.ts';

/** Shared by the four icon buttons, so they cannot drift apart. */
const ICON_BUTTON =
  'text-secondary hover:bg-hovered hover:text-primary rounded px-2 py-1 text-sm transition-colors';

export function TopBar(): ReactNode {
  const t = useT();
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

  return (
    <header className="bg-surface border-subtle sticky top-0 z-40 flex items-center gap-2 border-b px-3 py-2">
      <button
        type="button"
        onClick={toggleSidebar}
        className={`${ICON_BUTTON} lg:hidden`}
        aria-label={t('nav.open')}
      >
        ☰
      </button>

      {/* The brand doubles as the way home, which is what people try first. */}
      <Link
        to="/"
        className="text-primary hover:text-accent mr-auto text-base font-semibold tracking-tight transition-colors"
      >
        {t('app.name')}
      </Link>

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
        className="bg-base border-subtle text-primary w-32 rounded border px-2 py-1 text-sm sm:w-56"
      />

      <button
        type="button"
        onClick={requestRefresh}
        className={ICON_BUTTON}
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
        className={ICON_BUTTON}
        title={t(`theme.mode.${mode}`)}
        aria-label={t('topbar.theme', { mode: t(`theme.mode.${mode}`) })}
      >
        {mode === 'system' ? '◐' : resolved === 'dark' ? '☾' : '☀'}
      </button>

      <button
        type="button"
        onClick={toggleShortcuts}
        className={`${ICON_BUTTON} hidden sm:block`}
        title={t('shortcuts.title')}
        aria-label={t('shortcuts.title')}
      >
        ?
      </button>
    </header>
  );
}
