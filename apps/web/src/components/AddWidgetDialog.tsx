/**
 * Adding a widget: pick a type, name it, tune it.
 *
 * The type list comes from the client registry rather than from the server, so a
 * type the client cannot render is never offered. `custom_api` is absent until
 * Phase 6 for exactly that reason.
 */

import { useState, type ReactNode } from 'react';
import type { WidgetType } from '@nexuscentral/shared';
import { useCreateWidget } from '../api/queries.ts';
import { useT } from '../i18n.tsx';
import { AVAILABLE_DEFINITIONS } from '../widgets/registry.tsx';
import { Modal } from './Modal.tsx';

export interface AddWidgetDialogProps {
  dashboardId: number;
  onClose: () => void;
}

export function AddWidgetDialog({ dashboardId, onClose }: AddWidgetDialogProps): ReactNode {
  const t = useT();
  const create = useCreateWidget();

  const [type, setType] = useState<WidgetType | null>(null);
  const [title, setTitle] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});

  const definition = AVAILABLE_DEFINITIONS.find((candidate) => candidate.type === type);

  const choose = (next: (typeof AVAILABLE_DEFINITIONS)[number]): void => {
    setType(next.type);
    setConfig(next.defaultConfig());
    setTitle(t(next.labelKey));
  };

  const submit = (): void => {
    if (definition === undefined || title.trim() === '') return;
    create.mutate(
      { dashboardId, type: definition.type, title: title.trim(), config },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      title={t('dashboard.addWidget')}
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
            disabled={definition === undefined || title.trim() === '' || create.isPending}
            className="bg-accent text-accent-fg rounded px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {t('dashboard.widget.add')}
          </button>
        </>
      }
    >
      <fieldset>
        <legend className="text-secondary mb-2 text-sm">{t('dashboard.widget.type')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {AVAILABLE_DEFINITIONS.map((candidate) => (
            <button
              key={candidate.type}
              type="button"
              aria-pressed={type === candidate.type}
              onClick={() => choose(candidate)}
              className={[
                'rounded border p-2 text-left',
                type === candidate.type
                  ? 'border-strong bg-accent-subtle'
                  : 'border-subtle hover:bg-hovered',
              ].join(' ')}
            >
              <span className="text-primary block text-sm font-medium">
                {t(candidate.labelKey)}
              </span>
              <span className="text-muted block text-xs">{t(candidate.descriptionKey)}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {definition !== undefined && (
        <div className="mt-4 space-y-4">
          <label className="block text-sm">
            <span className="text-secondary">{t('dashboard.widget.title')}</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              className="mt-1 block w-full"
            />
          </label>

          <definition.ConfigForm value={config} onChange={setConfig} />
        </div>
      )}

      {create.error !== null && (
        <p role="alert" className="text-negative mt-3 text-sm">
          {create.error.message}
        </p>
      )}
    </Modal>
  );
}
