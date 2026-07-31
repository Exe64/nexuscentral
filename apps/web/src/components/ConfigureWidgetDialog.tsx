/**
 * Editing a widget's title and config.
 *
 * The form edits a local copy and only PATCHes on save, so abandoning the dialog
 * leaves the dashboard exactly as it was.
 */

import { useState, type ReactNode } from 'react';
import type { Widget } from '@nexuscentral/shared';
import { useUpdateWidget } from '../api/queries.ts';
import { useT } from '../i18n.tsx';
import { widgetDefinition } from '../widgets/registry.tsx';
import { Modal } from './Modal.tsx';

export interface ConfigureWidgetDialogProps {
  widget: Widget;
  onClose: () => void;
}

export function ConfigureWidgetDialog({ widget, onClose }: ConfigureWidgetDialogProps): ReactNode {
  const t = useT();
  const update = useUpdateWidget();
  const definition = widgetDefinition(widget.type);

  const [title, setTitle] = useState(widget.title);
  const [config, setConfig] = useState<Record<string, unknown>>(widget.config);

  const submit = (): void => {
    if (title.trim() === '') return;
    update.mutate({ id: widget.id, title: title.trim(), config }, { onSuccess: onClose });
  };

  return (
    <Modal
      title={t('dashboard.widget.configure')}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="border-subtle text-secondary hover:bg-hovered rounded border px-3 py-1.5 text-sm"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={title.trim() === '' || update.isPending}
            className="bg-accent text-accent-fg rounded px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="text-secondary">{t('dashboard.widget.title')}</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            className="mt-1 block w-full"
          />
        </label>

        {definition === undefined ? (
          <p className="text-secondary text-sm">
            {t('dashboard.widget.unknownType', { type: widget.type })}
          </p>
        ) : (
          <definition.ConfigForm value={config} onChange={setConfig} />
        )}
      </div>

      {update.error !== null && (
        <p role="alert" className="text-negative mt-3 text-sm">
          {update.error.message}
        </p>
      )}
    </Modal>
  );
}
