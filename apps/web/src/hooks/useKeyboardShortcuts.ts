/**
 * Keyboard shortcuts (04-SPEC-frontend.md 2).
 *
 * These are what make daily reading fast, so they are not deferred. The rules that
 * keep them from being infuriating:
 *
 * - Never fire while the user is typing. A `/` in a search box is a slash.
 * - Never swallow a browser or OS chord: anything with Ctrl, Meta or Alt passes
 *   straight through.
 * - `Escape` always works, even from inside a field, because that is how you get
 *   out of one.
 */

import { useEffect } from 'react';

export type ShortcutHandler = (event: KeyboardEvent) => void;

/** Keys are matched against `event.key`, so `?` and `/` are literal. */
export type ShortcutMap = Record<string, ShortcutHandler>;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useKeyboardShortcuts(shortcuts: ShortcutMap, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      // Ctrl+R must still reload the page, Cmd+K must still open the browser bar.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const typing = isTypingTarget(event.target);
      if (typing && event.key !== 'Escape') return;

      const handler = shortcuts[event.key];
      if (handler === undefined) return;

      event.preventDefault();
      handler(event);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts, enabled]);
}
