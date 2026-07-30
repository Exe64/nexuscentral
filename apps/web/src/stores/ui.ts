/**
 * UI state that outlives a single component: sidebar, overlay, search focus.
 *
 * Server state lives in TanStack Query; this is only the things the shell and the
 * shortcut handlers both need to see.
 */

import { create } from 'zustand';

interface UiState {
  /**
   * The top bar's search box.
   *
   * Kept here rather than threaded through the shell: the box lives in the top bar
   * and the results live in the route, and the two have no common ancestor that
   * would naturally own the value.
   */
  search: string;
  setSearch: (value: string) => void;

  /** Mobile only; on lg+ the sidebar is always present. */
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;

  shortcutsOpen: boolean;
  toggleShortcuts: () => void;
  closeShortcuts: () => void;

  /**
   * Incremented to ask the search box to take focus.
   *
   * A counter rather than a boolean: pressing `/` twice in a row has to focus
   * twice, and a boolean would already be true the second time.
   */
  searchFocusRequests: number;
  requestSearchFocus: () => void;

  /** Incremented to ask the current view to refetch, for the `r` shortcut. */
  refreshRequests: number;
  requestRefresh: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  search: '',
  setSearch: (search) => set({ search }),

  sidebarOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  closeSidebar: () => set({ sidebarOpen: false }),

  shortcutsOpen: false,
  toggleShortcuts: () => set((state) => ({ shortcutsOpen: !state.shortcutsOpen })),
  closeShortcuts: () => set({ shortcutsOpen: false }),

  searchFocusRequests: 0,
  requestSearchFocus: () =>
    set((state) => ({ searchFocusRequests: state.searchFocusRequests + 1 })),

  refreshRequests: 0,
  requestRefresh: () => set((state) => ({ refreshRequests: state.refreshRequests + 1 })),
}));
