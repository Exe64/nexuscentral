/**
 * `/tags` -- tag management.
 */

import { useState, type ReactNode } from 'react';
import { TAG_COLORS, type TagColor, type TagWithCounts } from '@feedhub/shared';
import { useCreateTag, useDeleteTag, useTags, useUpdateTag } from '../api/queries.ts';
import { ApiRequestError } from '../api/client.ts';
import { useT, type Translate } from '../i18n.tsx';

function AddTagForm({ t }: { t: Translate }): ReactNode {
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('neutral');
  const create = useCreateTag();

  return (
    <form
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
      <label>
        {t('tags.add.name.label')}
        <input
          value={name}
          placeholder={t('tags.add.name.placeholder')}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>

      <label>
        {t('tags.add.color.label')}
        <select value={color} onChange={(event) => setColor(event.target.value as TagColor)}>
          {TAG_COLORS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <button type="submit" disabled={create.isPending || name.trim() === ''}>
        {t('tags.add.submit')}
      </button>

      {create.error !== null && (
        <p role="alert">
          {create.error instanceof ApiRequestError && create.error.code === 'CONFLICT'
            ? t('error.conflict')
            : t('error.generic', { message: create.error.message })}
        </p>
      )}
      {create.isSuccess && <p role="status">{t('tags.added')}</p>}
    </form>
  );
}

function TagRow({ tag, t }: { tag: TagWithCounts; t: Translate }): ReactNode {
  const update = useUpdateTag();
  const remove = useDeleteTag();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(tag.name);

  return (
    <tr>
      <td>
        {renaming ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate(
                { id: tag.id, name: draft.trim() },
                { onSuccess: () => setRenaming(false) },
              );
            }}
          >
            <input value={draft} onChange={(event) => setDraft(event.target.value)} required />
            <button type="submit" disabled={update.isPending}>
              {t('common.save')}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(tag.name);
                setRenaming(false);
              }}
            >
              {t('common.cancel')}
            </button>
          </form>
        ) : (
          tag.name
        )}
      </td>
      <td>
        <code>{tag.slug}</code>
      </td>
      <td>
        <select
          value={tag.color}
          onChange={(event) => update.mutate({ id: tag.id, color: event.target.value as TagColor })}
          disabled={update.isPending}
        >
          {TAG_COLORS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </td>
      <td>{tag.sourceCount}</td>
      <td>{tag.unreadCount}</td>
      <td>
        {!renaming && (
          <button type="button" onClick={() => setRenaming(true)}>
            {t('tags.rename')}
          </button>
        )}{' '}
        <button
          type="button"
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
        </button>
        {remove.data !== undefined && (
          <span role="status">{t('tags.deleted', { widgets: remove.data.affectedWidgets })}</span>
        )}
      </td>
    </tr>
  );
}

export function Tags(): ReactNode {
  const t = useT();
  const tags = useTags();

  return (
    <section>
      <h2>{t('tags.title')}</h2>

      <AddTagForm t={t} />

      {tags.isPending && <p>{t('common.loading')}</p>}

      {tags.error !== null && (
        <p role="alert">
          {t('tags.error')}{' '}
          <button type="button" onClick={() => void tags.refetch()}>
            {t('common.retry')}
          </button>
        </p>
      )}

      {tags.data !== undefined && tags.data.length === 0 && <p>{t('tags.empty')}</p>}

      {tags.data !== undefined && tags.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('tags.column.name')}</th>
              <th>{t('tags.column.slug')}</th>
              <th>{t('tags.column.color')}</th>
              <th>{t('tags.column.sources')}</th>
              <th>{t('tags.column.unread')}</th>
              <th>{t('sources.column.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {tags.data.map((tag) => (
              <TagRow key={tag.id} tag={tag} t={t} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
