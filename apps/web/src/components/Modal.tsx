/**
 * A small modal.
 *
 * Escape and a click on the backdrop both close it: a dialog that traps you is
 * worse than no dialog. Focus moves into the panel on open so Escape and Tab
 * behave as expected.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '../i18n.tsx';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ title, onClose, children, footer }: ModalProps): ReactNode {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="bg-surface border-subtle flex max-h-full w-full max-w-lg flex-col rounded-lg border shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-subtle flex shrink-0 items-center border-b px-5 py-3">
          <h2 className="text-primary mr-auto text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-muted hover:bg-hovered hover:text-secondary rounded px-2 py-0.5"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer !== undefined && (
          <footer className="border-subtle flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
