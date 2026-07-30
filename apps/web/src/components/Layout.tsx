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
    <div className="bg-base text-primary min-h-screen lg:flex">
      <a href="#main" className="skip-link">
        {t('nav.skipToContent')}
      </a>

      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" className="min-w-0 flex-1 p-3 sm:p-4">
          {children}
        </main>
      </div>

      <ShortcutOverlay />
    </div>
  );
}
