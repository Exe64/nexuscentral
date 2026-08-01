/**
 * The app shell: sidebar, top bar, content.
 *
 * The global shortcuts live here so they work on every route. The reader adds its
 * own item-level bindings on top; both go through the same hook, which refuses to
 * fire while the user is typing.
 */

import { useMemo, type ReactNode } from 'react';
import { useT } from '../i18n.tsx';
import { useKeyboardShortcuts, type ShortcutMap } from '../hooks/useKeyboardShortcuts.ts';
import { useUiStore } from '../stores/ui.ts';
import { useThemeStore } from '../theme/store.ts';
import { PageBar } from './PageBar.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';
import { ShortcutOverlay } from './ShortcutOverlay.tsx';

export function Layout({ children }: { children: ReactNode }): ReactNode {
  const t = useT();
  const requestSearchFocus = useUiStore((state) => state.requestSearchFocus);
  const requestRefresh = useUiStore((state) => state.requestRefresh);
  const toggleShortcuts = useUiStore((state) => state.toggleShortcuts);
  const closeShortcuts = useUiStore((state) => state.closeShortcuts);
  const closeSidebar = useUiStore((state) => state.closeSidebar);
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);

  const shortcuts = useMemo<ShortcutMap>(
    () => ({
      '/': () => requestSearchFocus(),
      '?': () => toggleShortcuts(),
      r: () => requestRefresh(),
      t: () => setMode(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system'),
      Escape: () => {
        closeShortcuts();
        closeSidebar();
      },
    }),
    [
      requestSearchFocus,
      toggleShortcuts,
      requestRefresh,
      setMode,
      mode,
      closeShortcuts,
      closeSidebar,
    ],
  );

  useKeyboardShortcuts(shortcuts);

  return (
    // Two stacked bars, then the split. The application bar spans the full width
    // above the sidebar, so the brand and the global controls stay in one place
    // no matter which route is open; the page bar sits inside the content column
    // because it describes the content, not the navigation.
    <div className="bg-base text-primary flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        {t('nav.skipToContent')}
      </a>

      <TopBar />

      <div className="flex min-h-0 flex-1 lg:flex-row">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <PageBar />
          <main id="main" className="min-w-0 flex-1 p-3 sm:p-4">
            {children}
          </main>
        </div>
      </div>

      <ShortcutOverlay />
    </div>
  );
}
