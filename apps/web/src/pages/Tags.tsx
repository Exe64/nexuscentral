/**
 * `/tags` -- tag management.
 */

import { useState, type ReactNode } from 'react';
import { TAG_COLORS, type TagColor, type TagWithCounts } from '@nexuscentral/shared';
import { useCreateTag, useDeleteTag, useTags, useUpdateTag } from '../api/queries.ts';
import { ApiRequestError } from '../api/client.ts';
import { TagChip } from '../components/TagChip.tsx';
import {
  Button,
  EmptyState,
  Mono,
  Notice,
  PageHeader,
  Panel,
  SelectField,
  TD,
  TH,
  TR,
  Table,
  TextField,
} from '../components/ui.tsx';
import { useT, type Translate } from '../i18n.tsx';
import { formatNumber } from '../lib/format.ts';

function AddTagForm({ t }: { t: Translate }): ReactNode {
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('neutral');
  const create = useCreateTag();

  return (
    <Panel title={t('tags.add.title')}>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '') return;
          create.mutate(
            { name: name.trim(), color },
            {
              onSuccess: () => {
                setName('');
                setColor('neutral');
              },
            },
          );
        }}
      >
        <TextField
          label={t('tags.add.name.label')}
          value={name}
          placeholder={t('tags.add.name.placeholder')}
          onChange={(event) => setName(event.target.value)}
          required
          className="w-48"
        />

        <SelectField
          label={t('tags.add.color.label')}
          value={color}
          onChange={(event) => setColor(event.target.value as TagColor)}
          className="w-40"
        >
          {TAG_COLORS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SelectField>

        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || name.trim() === ''}
          className="mb-0.5"
        >
          {t('tags.add.submit')}
        </Button>
      </form>

      {create.error !== null && (
        <div className="mt-3">
          <Notice tone="error">
            {create.error instanceof ApiRequestError && create.error.code === 'CONFLICT'
              ? t('error.conflict')
              : t('error.generic', { message: create.error.message })}
          </Notice>
        </div>
      )}
      {create.isSuccess && (
        <div className="mt-3">
          <Notice tone="success">{t('tags.added')}</Notice>
        </div>
      )}
    </Panel>
  );
}

function TagRow({ tag, t }: { tag: TagWithCounts; t: Translate }): ReactNode {
  const update = useUpdateTag();
  const remove = useDeleteTag();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(tag.name);

  return (
    <TR>
      <TD>
        {renaming ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate(
                { id: tag.id, name: draft.trim() },
                { onSuccess: () => setRenaming(false) },
              );
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              required
              aria-label={t('tags.column.name')}
              className="bg-surface border-subtle text-primary w-40 rounded border px-2 py-1 text-sm"
            />
            <Button type="submit" size="sm" variant="primary" disabled={update.isPending}>
              {t('common.save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(tag.name);
                setRenaming(false);
              }}
            >
              {t('common.cancel')}
            </Button>
          </form>
        ) : (
          // The chip rather than the bare name: this page is where colours are
          // chosen, so seeing the result of the choice belongs here most of all.
          <TagChip tag={tag} />
        )}
      </TD>

      <TD>
        <Mono>{tag.slug}</Mono>
      </TD>

      <TD>
        <select
          value={tag.color}
          aria-label={t('tags.column.color')}
          onChange={(event) => update.mutate({ id: tag.id, color: event.target.value as TagColor })}
          disabled={update.isPending}
          className="bg-surface border-subtle text-primary rounded border px-2 py-1 text-sm"
        >
          {TAG_COLORS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </TD>

      <TD align="right">{formatNumber(tag.sourceCount)}</TD>
      <TD align="right">
        <span className={tag.unreadCount > 0 ? 'text-primary' : 'text-muted'}>
          {formatNumber(tag.unreadCount)}
        </span>
      </TD>

      <TD align="right">
        <div className="flex items-center justify-end gap-1">
          {!renaming && (
            <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
              {t('tags.rename')}
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              // The API reports how many widgets referenced the tag; confirming
              // first is the only chance to mention the sources it will leave.
              if (
                !window.confirm(
                  t('tags.delete.confirm', { name: tag.name, sourceCount: tag.sourceCount }),
                )
              ) {
                return;
              }
              remove.mutate(tag.id);
            }}
          >
            {t('common.delete')}
          </Button>
        </div>
        {remove.data !== undefined && (
          <span role="status" className="text-muted mt-1 block text-xs">
            {t('tags.deleted', { widgets: remove.data.affectedWidgets })}
          </span>
        )}
      </TD>
    </TR>
  );
}

export function Tags(): ReactNode {
  const t = useT();
  const tags = useTags();

  return (
    <section>
      <PageHeader description={t('tags.intro')} />

      <div className="space-y-5">
        <AddTagForm t={t} />

        {tags.isPending && <p className="text-secondary text-sm">{t('common.loading')}</p>}

        {tags.error !== null && (
          <Notice tone="error">
            {t('tags.error')}{' '}
            <button type="button" onClick={() => void tags.refetch()} className="underline">
              {t('common.retry')}
            </button>
          </Notice>
        )}

        {tags.data !== undefined && tags.data.length === 0 && (
          <EmptyState message={t('tags.empty')} />
        )}

        {tags.data !== undefined && tags.data.length > 0 && (
          <Table
            head={
              <>
                <TH>{t('tags.column.name')}</TH>
                <TH>{t('tags.column.slug')}</TH>
                <TH>{t('tags.column.color')}</TH>
                <TH align="right">{t('tags.column.sources')}</TH>
                <TH align="right">{t('tags.column.unread')}</TH>
                <TH align="right">{t('sources.column.actions')}</TH>
              </>
            }
          >
            {tags.data.map((tag) => (
              <TagRow key={tag.id} tag={tag} t={t} />
            ))}
          </Table>
        )}
      </div>
    </section>
  );
}
