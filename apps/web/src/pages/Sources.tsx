/**
 * `/sources` -- source management, including the resolve preview.
 *
 * The preview is the point: pasting a blog homepage and seeing three real items
 * before committing is what makes adding a source feel safe (03-SPEC-api.md 2).
 */

import { useRef, useState, type ReactNode } from 'react';
import { SOURCE_KINDS, type Source, type SourceKind } from '@nexuscentral/shared';
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
import { Modal } from '../components/Modal.tsx';
import { TagChip } from '../components/TagChip.tsx';
import {
  Button,
  CheckboxField,
  EmptyState,
  Mono,
  Notice,
  PageHeader,
  Panel,
  SelectField,
  SourceIcon,
  TD,
  TH,
  TR,
  Table,
  TextField,
} from '../components/ui.tsx';
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
    <Panel title={t('sources.add.title')} description={t('sources.add.intro')}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim() === '') return;
          resolve.mutate(input.trim());
        }}
      >
        <div className="min-w-64 flex-1">
          <label htmlFor="source-input" className="text-secondary mb-1 block text-sm">
            {t('sources.add.input.label')}
          </label>
          <input
            id="source-input"
            value={input}
            placeholder={t('sources.add.input.placeholder')}
            onChange={(event) => setInput(event.target.value)}
            required
            className="bg-surface border-subtle text-primary w-full rounded border px-2 py-1.5 text-sm"
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={resolve.isPending || input.trim() === ''}
          className="mb-0.5"
        >
          {resolve.isPending ? t('sources.add.resolving') : t('sources.add.preview')}
        </Button>
      </form>

      {resolve.error !== null && (
        <div className="mt-3">
          <Notice tone="error">
            {t('sources.add.failed', { message: resolve.error.message })}
          </Notice>
        </div>
      )}

      {candidates.length > 1 && (
        <p className="text-secondary mt-3 text-sm">
          {t('sources.add.candidates', { count: candidates.length })}
        </p>
      )}

      {candidates.length > 0 && (tags.data ?? []).length > 0 && (
        <fieldset className="mt-3">
          <legend className="text-secondary text-sm">{t('sources.column.tags')}</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {(tags.data ?? []).map((tag) => (
              <CheckboxField
                key={tag.id}
                label={tag.name}
                checked={selectedTagIds.includes(tag.id)}
                onChange={(event) =>
                  setSelectedTagIds((current) =>
                    event.target.checked
                      ? [...current, tag.id]
                      : current.filter((id) => id !== tag.id),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
      )}

      <div className="mt-3 space-y-3">
        {candidates.map((candidate) => (
          <article
            key={candidate.identifier}
            className="border-subtle bg-base rounded-lg border p-3"
          >
            <h3 className="text-primary text-sm font-medium">{candidate.title}</h3>
            <p className="mt-1">
              <Mono>{candidate.identifier}</Mono>
            </p>

            <p className="text-muted mt-2 text-xs">{t('sources.add.sampleItems')}</p>
            <ul className="divide-subtle mt-1 divide-y">
              {candidate.sampleItems.map((item) => (
                <li key={item.url} className="py-1">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-primary hover:text-accent block text-sm leading-snug"
                  >
                    {item.title}
                  </a>
                  <time
                    dateTime={item.publishedAt}
                    title={absoluteTime(item.publishedAt)}
                    className="text-muted text-xs"
                  >
                    {relativeTime(item.publishedAt)}
                  </time>
                </li>
              ))}
            </ul>

            <div className="mt-3">
              {candidate.existingSourceId === null ? (
                <Button
                  variant="primary"
                  size="sm"
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
                </Button>
              ) : (
                <Notice tone="info">{t('sources.add.alreadyTracked')}</Notice>
              )}
            </div>
          </article>
        ))}
      </div>

      {create.error !== null && (
        <div className="mt-3">
          <Notice tone="error">{t('error.generic', { message: create.error.message })}</Notice>
        </div>
      )}
      {create.isSuccess && (
        <div className="mt-3">
          <Notice tone="success">{t('sources.added')}</Notice>
        </div>
      )}
    </Panel>
  );
}

function OpmlPanel({ t }: { t: Translate }): ReactNode {
  const fileInput = useRef<HTMLInputElement>(null);
  const [importCategoriesAsTags, setImportCategoriesAsTags] = useState(true);
  const importOpml = useImportOpml();

  return (
    <Panel title={t('opml.title')}>
      <div className="space-y-3">
        <CheckboxField
          label={t('opml.importCategoriesAsTags')}
          checked={importCategoriesAsTags}
          onChange={(event) => setImportCategoriesAsTags(event.target.checked)}
        />

        <div>
          <label htmlFor="opml-file" className="text-secondary mb-1 block text-sm">
            {t('opml.import')}
          </label>
          <input
            id="opml-file"
            ref={fileInput}
            type="file"
            accept=".opml,.xml,text/xml,application/xml"
            className="text-secondary text-sm"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file === undefined) return;
              const opml = await file.text();
              importOpml.mutate({ opml, importCategoriesAsTags });
              // Clear the input so re-selecting the same file fires again.
              if (fileInput.current !== null) fileInput.current.value = '';
            }}
          />
        </div>

        {importOpml.isPending && <Notice tone="info">{t('opml.importing')}</Notice>}

        {importOpml.data !== undefined && (
          <>
            <Notice tone="success">
              {t('opml.imported', {
                created: importOpml.data.created,
                alreadyTracked: importOpml.data.alreadyTracked,
              })}
            </Notice>
            {importOpml.data.failed.length > 0 && (
              <Notice tone="error">
                {t('opml.importFailedSome', { count: importOpml.data.failed.length })}
              </Notice>
            )}
          </>
        )}

        {importOpml.error !== null && (
          <Notice tone="error">{t('error.generic', { message: importOpml.error.message })}</Notice>
        )}

        {/* A plain link: the endpoint sets Content-Disposition, so the browser
            downloads it without any JavaScript involved. */}
        <a href="/api/sources/export" download className="text-accent inline-block text-sm">
          {t('opml.export')}
        </a>
      </div>
    </Panel>
  );
}

/** The health cell is the reason to open this page, so it carries a colour. */
function health(source: Source, t: Translate): { label: string; tone: string } {
  if (!source.active) return { label: t('sources.health.inactive'), tone: 'text-muted' };
  if (source.health.consecutiveFailures > 0) {
    return {
      label: t('sources.health.failing', { count: source.health.consecutiveFailures }),
      tone: 'text-negative',
    };
  }
  if (source.health.consecutiveEmpty > 0) {
    // Counted separately because nothing about those runs looked like an error.
    return {
      label: t('sources.health.empty', { count: source.health.consecutiveEmpty }),
      tone: 'text-warning',
    };
  }
  if (source.health.lastOkAt === null) {
    return { label: t('sources.health.never'), tone: 'text-muted' };
  }
  return { label: t('sources.health.ok'), tone: 'text-positive' };
}

/**
 * The intervals worth offering, so the common case is a click.
 *
 * A free-text box would be the more flexible control and the worse one: the API
 * parses `"15 minutes"` and rejects anything else, so every typo becomes a round
 * trip and an error message. Values outside this list are still reachable —
 * `intervalOptions` keeps whatever the source already has.
 */
const POLL_INTERVALS = [
  '5 minutes',
  '15 minutes',
  '30 minutes',
  '1 hour',
  '2 hours',
  '6 hours',
  '12 hours',
  '1 day',
];

/**
 * The presets, plus the source's current value when it is not one of them.
 *
 * OPML import and older rows carry intervals nobody would pick from a list, and
 * a select that silently dropped them would change the schedule the moment
 * anything else on the form was saved.
 */
export function intervalOptions(current: string): string[] {
  return POLL_INTERVALS.includes(current) ? POLL_INTERVALS : [current, ...POLL_INTERVALS];
}

/**
 * Everything about a source that can be changed after it exists.
 *
 * A dialog rather than the inline editor this replaces: the row was already
 * carrying six columns, and editing an interval inside a table cell that also
 * has to show health is how a table stops being readable.
 */
function EditSourceDialog({
  source,
  t,
  onClose,
}: {
  source: Source;
  t: Translate;
  onClose: () => void;
}): ReactNode {
  const tags = useTags();
  const update = useUpdateSource();

  const [title, setTitle] = useState(source.title);
  const [pollInterval, setPollInterval] = useState(source.pollInterval);
  const [weight, setWeight] = useState(String(source.weight));
  const [selected, setSelected] = useState<number[]>(source.tags.map((tag) => tag.id));

  const parsedWeight = Number(weight);
  const weightValid = Number.isFinite(parsedWeight) && parsedWeight >= 0 && parsedWeight <= 10;

  const save = (): void => {
    if (!weightValid) return;

    update.mutate(
      {
        id: source.id,
        title: title.trim(),
        pollInterval,
        weight: parsedWeight,
        // PATCH replaces the tag set rather than merging it, so the checkbox
        // state is the whole answer.
        tagIds: selected,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      title={t('sources.edit.title')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {/* Calls the handler rather than relying on `form=` association: the
              button lives in the modal's footer, outside the <form>, and that
              association is not something every environment implements. Enter
              inside the form still submits, through onSubmit below. */}
          <Button variant="primary" disabled={update.isPending || !weightValid} onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        className="space-y-4"
      >
        <TextField
          label={t('sources.edit.name')}
          value={title}
          required
          onChange={(event) => setTitle(event.target.value)}
          hint={t('sources.edit.name.hint')}
        />

        <SelectField
          label={t('sources.edit.interval')}
          value={pollInterval}
          onChange={(event) => setPollInterval(event.target.value)}
          hint={t('sources.edit.interval.hint')}
        >
          {intervalOptions(source.pollInterval).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SelectField>

        <TextField
          label={t('sources.edit.weight')}
          type="number"
          min={0}
          max={10}
          step={0.1}
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
          hint={t('sources.edit.weight.hint')}
          {...(weightValid ? {} : { error: t('sources.edit.weight.invalid') })}
        />

        <fieldset>
          <legend className="text-secondary mb-1 block text-sm">{t('sources.edit.tags')}</legend>
          {(tags.data ?? []).length === 0 ? (
            <p className="text-muted text-xs">{t('sources.edit.tags.none')}</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {(tags.data ?? []).map((tag) => (
                <CheckboxField
                  key={tag.id}
                  label={tag.name}
                  checked={selected.includes(tag.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, tag.id]
                        : current.filter((id) => id !== tag.id),
                    )
                  }
                />
              ))}
            </div>
          )}
        </fieldset>

        {/* The API validates the interval and the weight too. Showing its message
            rather than a generic one is the difference between "that failed" and
            knowing which field to fix. */}
        {update.error !== null && <Notice tone="error">{update.error.message}</Notice>}
      </form>
    </Modal>
  );
}

function SourceRow({ source, t }: { source: Source; t: Translate }): ReactNode {
  const poll = usePollSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const [editing, setEditing] = useState(false);

  const state = health(source, t);

  return (
    <TR>
      <TD className="max-w-xs">
        {/* The icon is shown here because this is the page where you would
            notice it resolved to the wrong thing -- a guessed /favicon.ico, or
            Reddit's generic logo on a subreddit added without credentials. */}
        <div className="flex items-center gap-2">
          <SourceIcon src={source.iconUrl} />
          {source.siteUrl === null ? (
            <span className="text-primary text-sm font-medium">{source.title}</span>
          ) : (
            <a
              href={source.siteUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:text-accent text-sm font-medium"
            >
              {source.title}
            </a>
          )}
        </div>
        <span className="text-muted mt-0.5 block truncate text-xs" title={source.identifier}>
          {source.identifier}
        </span>
      </TD>

      <TD>
        <span className="text-secondary text-xs uppercase">{source.kind}</span>
      </TD>

      <TD>
        <div className="flex flex-wrap items-center gap-1">
          {source.tags.length === 0 ? (
            <span className="text-muted text-xs">{t('sources.noTags')}</span>
          ) : (
            source.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)
          )}
        </div>
      </TD>

      <TD>
        <span className="text-secondary text-xs">{source.pollInterval}</span>
        {/* Weight only when it is not the default: a column of "×1.00" teaches
            nothing, and a weight that is not 1 changes every score. */}
        {source.weight !== 1 && (
          <span className="text-muted mt-0.5 block text-xs tabular-nums">
            ×{source.weight.toFixed(2)}
          </span>
        )}
      </TD>

      <TD>
        <span className={`text-xs ${state.tone}`}>{state.label}</span>
        {source.health.lastOkAt !== null && (
          <time
            dateTime={source.health.lastOkAt}
            title={absoluteTime(source.health.lastOkAt)}
            className="text-muted mt-0.5 block text-xs"
          >
            {relativeTime(source.health.lastOkAt)}
          </time>
        )}
        {source.health.lastError !== null && (
          <span
            className="text-muted mt-0.5 block max-w-48 truncate text-xs"
            title={source.health.lastError}
          >
            {source.health.lastError}
          </span>
        )}
      </TD>

      <TD align="right">
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" onClick={() => setEditing(true)}>
            {t('sources.edit')}
          </Button>
          <Button size="sm" disabled={poll.isPending} onClick={() => poll.mutate(source.id)}>
            {t('sources.pollNow')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: source.id, active: !source.active })}
          >
            {source.active ? t('sources.deactivate') : t('sources.activate')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (!window.confirm(t('sources.delete.confirm', { title: source.title }))) return;
              remove.mutate(source.id);
            }}
          >
            {t('common.delete')}
          </Button>
        </div>
        {poll.data !== undefined && (
          <span role="status" className="text-muted mt-1 block text-xs">
            {poll.data.queued ? t('sources.polling') : t('sources.pollNotQueued')}
          </span>
        )}

        {editing && <EditSourceDialog source={source} t={t} onClose={() => setEditing(false)} />}
      </TD>
    </TR>
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
      <PageHeader description={t('sources.intro')} />

      <div className="space-y-5">
        <AddSourcePanel t={t} />
        <OpmlPanel t={t} />

        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-primary mr-auto text-base font-semibold">
              {t('sources.list.title')}
            </h2>
            <input
              type="search"
              value={q}
              aria-label={t('sources.filter.q.placeholder')}
              placeholder={t('sources.filter.q.placeholder')}
              onChange={(event) => setQ(event.target.value)}
              className="bg-surface border-subtle text-primary w-56 rounded border px-2 py-1 text-sm"
            />
            <select
              value={kind}
              aria-label={t('sources.column.kind')}
              onChange={(event) => setKind(event.target.value as SourceKind | '')}
              className="bg-surface border-subtle text-primary rounded border px-2 py-1 text-sm"
            >
              <option value="">{t('sources.filter.allKinds')}</option>
              {SOURCE_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          {sources.isPending && <p className="text-secondary text-sm">{t('common.loading')}</p>}

          {sources.error !== null && (
            <Notice tone="error">
              {t('sources.error')}{' '}
              <button type="button" onClick={() => void sources.refetch()} className="underline">
                {t('common.retry')}
              </button>
            </Notice>
          )}

          {sources.data !== undefined && sources.data.length === 0 && (
            <EmptyState message={t('sources.empty')} />
          )}

          {sources.data !== undefined && sources.data.length > 0 && (
            <Table
              head={
                <>
                  <TH>{t('sources.column.title')}</TH>
                  <TH>{t('sources.column.kind')}</TH>
                  <TH>{t('sources.column.tags')}</TH>
                  <TH>{t('sources.column.interval')}</TH>
                  <TH>{t('sources.column.health')}</TH>
                  <TH align="right">{t('sources.column.actions')}</TH>
                </>
              }
            >
              {sources.data.map((source) => (
                <SourceRow key={source.id} source={source} t={t} />
              ))}
            </Table>
          )}
        </div>
      </div>
    </section>
  );
}
