/**
 * Theme state (04-SPEC-frontend.md 5.1).
 *
 * `localStorage` is the render-time cache so the page can pick a theme before any
 * JavaScript module loads; PostgreSQL is the source of truth. On boot the settings
 * are fetched and reconciled, and the server value wins.
 *
 * `data-theme` on `<html>` is always a concrete `light` or `dark`, never `system`,
 * so no stylesheet has to branch on a media query.
 */

import { create } from 'zustand';
import {
  DARK_NATIVE_PRESETS,
  THEME_PRESETS,
  type ThemeMode,
  type ThemePreset,
} from '@nexuscentral/shared';

/** The same key the inline no-flash script in index.html reads. */
export const STORAGE_KEY = 'nexuscentral.theme';

/** The two chroma steps behind the "Muted / Vivid" control. */
export const CHROMA_MUTED = 0.06;
export const CHROMA_VIVID = 0.14;

export const DEFAULT_THEME = {
  mode: 'system' as ThemeMode,
  preset: 'default' as ThemePreset,
  hue: 250,
  chroma: CHROMA_VIVID,
};

export interface StoredTheme {
  mode: ThemeMode;
  /** A named palette, or `default` for the accent-derived ramp. */
  preset: ThemePreset;
  hue: number;
  chroma: number;
}

interface ThemeState extends StoredTheme {
  /** What `data-theme` currently is: `system` resolved against the OS preference. */
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  /**
   * Returns the mode that ended up applied. Selecting a dark-native preset
   * switches to dark, because "terminal" on a white page is not the thing
   * anyone asked for. Nothing is locked: the mode control still works.
   */
  setPreset: (preset: ThemePreset) => { mode: ThemeMode };
  setHue: (hue: number) => void;
  setChroma: (chroma: number) => void;
  /** Applied without persisting, for dragging the hue slider. */
  previewHue: (hue: number) => void;
  /** Adopt the server's values. Called once on boot. */
  adoptFromServer: (theme: StoredTheme) => void;
  /** Re-resolve after the OS preference changed. */
  systemPreferenceChanged: () => void;
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

function readStored(): StoredTheme {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_THEME;
    const stored = parsed as Partial<StoredTheme>;
    return {
      mode:
        stored.mode === 'light' || stored.mode === 'dark' || stored.mode === 'system'
          ? stored.mode
          : DEFAULT_THEME.mode,
      preset: isPreset(stored.preset) ? stored.preset : DEFAULT_THEME.preset,
      hue: typeof stored.hue === 'number' ? clampHue(stored.hue) : DEFAULT_THEME.hue,
      chroma: typeof stored.chroma === 'number' ? clampChroma(stored.chroma) : DEFAULT_THEME.chroma,
    };
  } catch {
    // A corrupt cache must not stop the app rendering.
    return DEFAULT_THEME;
  }
}

function persist(theme: StoredTheme): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // Private browsing, quota, whatever. The server still has it.
  }
}

function isPreset(value: unknown): value is ThemePreset {
  return typeof value === 'string' && (THEME_PRESETS as readonly string[]).includes(value);
}

export const clampHue = (hue: number): number => Math.min(360, Math.max(0, Math.round(hue)));
export const clampChroma = (chroma: number): number => Math.min(0.37, Math.max(0, chroma));

/**
 * Write the theme onto `<html>`.
 *
 * The attribute and the two custom properties are exactly what the inline script
 * sets, so the first paint and every later update agree.
 */
export function applyTheme(theme: StoredTheme): 'light' | 'dark' {
  const resolved = resolveMode(theme.mode);
  if (typeof document === 'undefined') return resolved;

  const root = document.documentElement;
  root.dataset['theme'] = resolved;
  root.dataset['preset'] = theme.preset;
  root.style.setProperty('--accent-h', String(theme.hue));
  root.style.setProperty('--accent-c', String(theme.chroma));
  return resolved;
}

const initial = readStored();

export const useThemeStore = create<ThemeState>((set, get) => ({
  ...initial,
  resolved: applyTheme(initial),

  setPreset: (preset) => {
    const current = pick(get());
    const mode = DARK_NATIVE_PRESETS.includes(preset) ? ('dark' as ThemeMode) : current.mode;
    const next = { ...current, preset, mode };
    persist(next);
    set({ ...next, resolved: applyTheme(next) });
    return { mode };
  },

  setMode: (mode) => {
    const next = { ...pick(get()), mode };
    persist(next);
    set({ ...next, resolved: applyTheme(next) });
  },

  setHue: (hue) => {
    const next = { ...pick(get()), hue: clampHue(hue) };
    persist(next);
    set({ ...next, resolved: applyTheme(next) });
  },

  setChroma: (chroma) => {
    const next = { ...pick(get()), chroma: clampChroma(chroma) };
    persist(next);
    set({ ...next, resolved: applyTheme(next) });
  },

  previewHue: (hue) => {
    // Live preview applied immediately, persisted on release: dragging a slider
    // must not write to localStorage and the database sixty times a second.
    const next = { ...pick(get()), hue: clampHue(hue) };
    set({ ...next, resolved: applyTheme(next) });
  },

  adoptFromServer: (theme) => {
    const next = {
      mode: theme.mode,
      preset: theme.preset,
      hue: clampHue(theme.hue),
      chroma: clampChroma(theme.chroma),
    };
    persist(next);
    set({ ...next, resolved: applyTheme(next) });
  },

  systemPreferenceChanged: () => {
    const current = pick(get());
    if (current.mode !== 'system') return;
    set({ resolved: applyTheme(current) });
  },
}));

function pick(state: ThemeState): StoredTheme {
  return { mode: state.mode, preset: state.preset, hue: state.hue, chroma: state.chroma };
}
