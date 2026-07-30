/**
 * The `?` overlay.
 *
 * Lists the shortcuts rather than expecting anyone to discover them. Closes on
 * Escape and on a click outside, because a modal that traps you is worse than no
 * modal.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '../i18n.tsx';
import { useUiStore } from '../stores/ui.ts';

const SHORTCUTS: { keys: string[]; labelKey: string }[] = [
  { keys: ['j'], labelKey: 'shortcuts.next' },
  { keys: ['k'], labelKey: 'shortcuts.previous' },
  { keys: ['o', 'Enter'], labelKey: 'shortcuts.open' },
  { keys: ['m'], labelKey: 'shortcuts.toggleRead' },
  { keys: ['s'], labelKey: 'shortcuts.star' },
  { keys: ['r'], labelKey: 'shortcuts.refresh' },
  { keys: ['/'], labelKey: 'shortcuts.search' },
  { keys: ['t'], labelKey: 'shortcuts.theme' },
  { keys: ['?'], labelKey: 'shortcuts.help' },
  { keys: ['Esc'], labelKey: 'shortcuts.dismiss' },
];

export function ShortcutOverlay(): ReactNode {
  const t = useT();
  const open = useUiStore((state) => state.shortcutsOpen);
  const close = useUiStore((state) => state.closeShortcuts);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Move focus into the dialog so Escape and Tab behave as expected.
    panel.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={close}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.title')}
        tabIndex={-1}
        className="bg-surface border-subtle max-h-full w-full max-w-md overflow-y-auto rounded-lg border p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-primary mb-4 text-base font-semibold">{t('shortcuts.title')}</h2>

        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.labelKey} className="col-span-2 grid grid-cols-subgrid items-center">
              <dt className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="border-subtle bg-raised text-primary rounded border px-1.5 py-0.5 text-xs"
                  >
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd className="text-secondary">{t(shortcut.labelKey)}</dd>
            </div>
          ))}
        </dl>

        <button
          type="button"
          onClick={close}
          className="border-subtle text-secondary hover:bg-hovered mt-5 rounded border px-3 py-1.5 text-sm"
        >
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
