/**
 * `/sources` -- source management, including the resolve preview.
 *
 * The preview is the point: pasting a blog homepage and seeing three real items
 * before committing is what makes adding a source feel safe (03-SPEC-api.md 2).
 */

import { useRef, useState, type ReactNode } from 'react';
import { SOURCE_KINDS, type Source, type SourceKind } from '@feedhub/shared';
import {
  useCreateSource,
  useDeleteSource,
  useImportOpml,
  usePollSource,
  useResolveSource,
  useSources,
  useTags,
  useUpdateSource,
  type ResolveCandidate,
} from '../api/queries.ts';
import { useT, type Translate } from '../i18n.tsx';
import { absoluteTime, relativeTime } from '../lib/format.ts';

function AddSourcePanel({ t }: { t: Translate }): ReactNode {
  const [input, setInput] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const resolve = useResolveSource();
  const create = useCreateSource();
  const tags = useTags();

  const candidates: ResolveCandidate[] = resolve.data ?? [];

  return (
    <section>
      <h3>{t('sources.add.input.label')}</h3>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim() === '') return;
          resolve.mutate(input.trim());
        }}
      >
        <label>
          {t('sources.add.input.label')}
          <input
            value={input}
            placeholder={t('sources.add.input.placeholder')}
            onChange={(event) => setInput(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={resolve.isPending || input.trim() === ''}>
          {resolve.isPending ? t('sources.add.resolving') : t('sources.add.preview')}
        </button>
      </form>

      {resolve.error !== null && (
        <p role="alert">{t('sources.add.failed', { message: resolve.error.message })}</p>
      )}

      {candidates.length > 1 && <p>{t('sources.add.candidates', { count: candidates.length })}</p>}

      {candidates.length > 0 && (tags.data ?? []).length > 0 && (
        <fieldset>
          <legend>{t('sources.column.tags')}</legend>
          {(tags.data ?? []).map((tag) => (
            <label key={tag.id}>
              <input
                type="checkbox"
                checked={selectedTagIds.includes(tag.id)}
                onChange={(event) =>
                  setSelectedTagIds((current) =>
                    event.target.checked
                      ? [...current, tag.id]
                      : current.filter((id) => id !== tag.id),
                  )
                }
              />
              {tag.name}
            </label>
          ))}
        </fieldset>
      )}

      {candidates.map((candidate) => (
        <article key={candidate.identifier}>
          <h4>{candidate.title}</h4>
          <p>
            <code>{candidate.identifier}</code>
          </p>

          <p>{t('sources.add.sampleItems')}</p>
          <ul>
            {candidate.sampleItems.map((item) => (
              <li key={item.url}>
                <a href={item.url} target="_blank" rel="noreferrer noopener">
                  {item.title}
                </a>{' '}
                <time dateTime={item.publishedAt} title={absoluteTime(item.publishedAt)}>
                  {relativeTime(item.publishedAt)}
                </time>
              </li>
            ))}
          </ul>

          {candidate.existingSourceId === null ? (
            <button
              type="button"
              disabled={create.isPending}
              onClick={() =>
                create.mutate(
                  {
                    kind: candidate.kind,
                    identifier: candidate.identifier,
                    title: candidate.title,
                    siteUrl: candidate.siteUrl ?? null,
                    iconUrl: candidate.iconUrl ?? null,
                    tagIds: selectedTagIds,
                  },
                  {
                    onSuccess: () => {
                      setInput('');
                      setSelectedTagIds([]);
                      resolve.reset();
                    },
                  },
                )
              }
            >
              {t('sources.add.confirm')}
            </button>
          ) : (
            <p>{t('sources.add.alreadyTracked')}</p>
          )}
        </article>
      ))}

      {create.error !== null && (
        <p role="alert">{t('error.generic', { message: create.error.message })}</p>
      )}
      {create.isSuccess && <p role="status">{t('sources.added')}</p>}
    </section>
  );
}

function OpmlPanel({ t }: { t: Translate }): ReactNode {
  const fileInput = useRef<HTMLInputElement>(null);
  const [importCategoriesAsTags, setImportCategoriesAsTags] = useState(true);
  const importOpml = useImportOpml();

  return (
    <section>
      <h3>{t('opml.title')}</h3>

      <label>
        <input
          type="checkbox"
          checked={importCategoriesAsTags}
          onChange={(event) => setImportCategoriesAsTags(event.target.checked)}
        />
        {t('opml.importCategoriesAsTags')}
      </label>

      <label htmlFor="opml-file">{t('opml.import')}</label>
      <input
        id="opml-file"
        ref={fileInput}
        type="file"
        accept=".opml,.xml,text/xml,application/xml"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file === undefined) return;
          const opml = await file.text();
          importOpml.mutate({ opml, importCategoriesAsTags });
          // Clear the input so re-selecting the same file fires again.
          if (fileInput.current !== null) fileInput.current.value = '';
        }}
      />

      {importOpml.isPending && <p>{t('opml.importing')}</p>}

      {importOpml.data !== undefined && (
        <>
          <p role="status">
            {t('opml.imported', {
              created: importOpml.data.created,
              alreadyTracked: importOpml.data.alreadyTracked,
            })}
          </p>
          {importOpml.data.failed.length > 0 && (
            <p role="alert">
              {t('opml.importFailedSome', { count: importOpml.data.failed.length })}
            </p>
          )}
        </>
      )}

      {importOpml.error !== null && (
        <p role="alert">{t('error.generic', { message: importOpml.error.message })}</p>
      )}

      {/* A plain link: the endpoint sets Content-Disposition, so the browser
          downloads it without any JavaScript involved. */}
      <p>
        <a href="/api/sources/export" download>
          {t('opml.export')}
        </a>
      </p>
    </section>
  );
}

function healthLabel(source: Source, t: Translate): string {
  if (!source.active) return t('sources.health.inactive');
  if (source.health.consecutiveFailures > 0) {
    return t('sources.health.failing', { count: source.health.consecutiveFailures });
  }
  if (source.health.consecutiveEmpty > 0) {
    return t('sources.health.empty', { count: source.health.consecutiveEmpty });
  }
  if (source.health.lastOkAt === null) return t('sources.health.never');
  return t('sources.health.ok');
}

function TagEditor({
  source,
  t,
  onDone,
}: {
  source: Source;
  t: Translate;
  onDone: () => void;
}): ReactNode {
  const tags = useTags();
  const update = useUpdateSource();
  const [selected, setSelected] = useState<number[]>(source.tags.map((tag) => tag.id));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // PATCH replaces the tag set rather than merging it, so the checkbox
        // state is the whole answer.
        update.mutate({ id: source.id, tagIds: selected }, { onSuccess: onDone });
      }}
    >
      {(tags.data ?? []).map((tag) => (
        <label key={tag.id}>
          <input
            type="checkbox"
            checked={selected.includes(tag.id)}
            onChange={(event) =>
              setSelected((current) =>
                event.target.checked ? [...current, tag.id] : current.filter((id) => id !== tag.id),
              )
            }
          />
          {tag.name}
        </label>
      ))}
      <button type="submit" disabled={update.isPending}>
        {t('common.save')}
      </button>
      <button type="button" onClick={onDone}>
        {t('common.cancel')}
      </button>
    </form>
  );
}

function SourceRow({ source, t }: { source: Source; t: Translate }): ReactNode {
  const poll = usePollSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const [editingTags, setEditingTags] = useState(false);

  return (
    <tr>
      <td>
        {source.siteUrl === null ? (
          source.title
        ) : (
          <a href={source.siteUrl} target="_blank" rel="noreferrer noopener">
            {source.title}
          </a>
        )}
        <br />
        <code>{source.identifier}</code>
      </td>
      <td>{source.kind}</td>
      <td>
        {editingTags ? (
          <TagEditor source={source} t={t} onDone={() => setEditingTags(false)} />
        ) : (
          <>
            {source.tags.map((tag) => tag.name).join(', ')}{' '}
            <button type="button" onClick={() => setEditingTags(true)}>
              {t('sources.editTags')}
            </button>
          </>
        )}
      </td>
      <td>{source.pollInterval}</td>
      <td>
        {healthLabel(source, t)}
        {source.health.lastError !== null && (
          <>
            <br />
            <small>{source.health.lastError}</small>
          </>
        )}
        {source.health.lastOkAt !== null && (
          <>
            <br />
            <time dateTime={source.health.lastOkAt} title={absoluteTime(source.health.lastOkAt)}>
              {relativeTime(source.health.lastOkAt)}
            </time>
          </>
        )}
      </td>
      <td>
        <button type="button" disabled={poll.isPending} onClick={() => poll.mutate(source.id)}>
          {t('sources.pollNow')}
        </button>
        {poll.data !== undefined && (
          <span role="status">
            {poll.data.queued ? t('sources.polling') : t('sources.pollNotQueued')}
          </span>
        )}{' '}
        <button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: source.id, active: !source.active })}
        >
          {source.active ? t('sources.deactivate') : t('sources.activate')}
        </button>{' '}
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (!window.confirm(t('sources.delete.confirm', { title: source.title }))) return;
            remove.mutate(source.id);
          }}
        >
          {t('common.delete')}
        </button>
      </td>
    </tr>
  );
}

export function Sources(): ReactNode {
  const t = useT();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<SourceKind | ''>('');

  const sources = useSources({
    ...(q.trim() === '' ? {} : { q: q.trim() }),
    ...(kind === '' ? {} : { kind }),
  });

  return (
    <section>
      <h2>{t('sources.title')}</h2>

      <AddSourcePanel t={t} />
      <OpmlPanel t={t} />

      <h3>{t('sources.title')}</h3>

      <form
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <input
          type="search"
          value={q}
          placeholder={t('sources.filter.q.placeholder')}
          onChange={(event) => setQ(event.target.value)}
        />
        <select value={kind} onChange={(event) => setKind(event.target.value as SourceKind | '')}>
          <option value="">{t('sources.filter.allKinds')}</option>
          {SOURCE_KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </form>

      {sources.isPending && <p>{t('common.loading')}</p>}

      {sources.error !== null && (
        <p role="alert">
          {t('sources.error')}{' '}
          <button type="button" onClick={() => void sources.refetch()}>
            {t('common.retry')}
          </button>
        </p>
      )}

      {sources.data !== undefined && sources.data.length === 0 && <p>{t('sources.empty')}</p>}

      {sources.data !== undefined && sources.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('sources.column.title')}</th>
              <th>{t('sources.column.kind')}</th>
              <th>{t('sources.column.tags')}</th>
              <th>{t('sources.column.interval')}</th>
              <th>{t('sources.column.health')}</th>
              <th>{t('sources.column.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {sources.data.map((source) => (
              <SourceRow key={source.id} source={source} t={t} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
