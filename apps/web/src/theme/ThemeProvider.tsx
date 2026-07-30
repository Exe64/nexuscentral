/**
 * Keeps the applied theme in step with the OS preference and with the server.
 *
 * Renders nothing. Two jobs:
 *
 * 1. In `system` mode, follow `prefers-color-scheme` as it changes -- someone
 *    whose OS switches at sunset should not have to reload.
 * 2. Reconcile with the database once on boot. `localStorage` got the first paint
 *    right; the server decides what is actually true.
 */

import { useEffect, type ReactNode } from 'react';
import { useSettings } from '../api/queries.ts';
import { useThemeStore } from './store.ts';

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const settings = useSettings();
  const adoptFromServer = useThemeStore((state) => state.adoptFromServer);
  const systemPreferenceChanged = useThemeStore((state) => state.systemPreferenceChanged);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => systemPreferenceChanged();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [systemPreferenceChanged]);

  useEffect(() => {
    if (settings.data === undefined) return;
    adoptFromServer({
      mode: settings.data.themeMode,
      preset: settings.data.themePreset,
      hue: settings.data.accentHue,
      chroma: settings.data.accentChroma,
    });
    // Only on the first successful load: adopting on every refetch would fight a
    // user who is mid-edit in the settings form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.isSuccess]);

  return children;
}
