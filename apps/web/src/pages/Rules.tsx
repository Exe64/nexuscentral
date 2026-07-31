/**
 * `/rules` -- the rule editor with a live test panel.
 *
 * The panel is the point: without it, rules are written blind. It runs the pattern
 * against real recent items as the user types and saves nothing.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { RULE_SCOPES, type Rule, type RuleScope } from '@nexuscentral/shared';
import {
  useCreateRule,
  useDeleteRule,
  useRules,
  useRuleTest,
  useTags,
  useUpdateRule,
} from '../api/queries.ts';
import {
  Button,
  CheckboxField,
  EmptyState,
  Mono,
  Notice,
  PageHeader,
  Panel,
  TD,
  TH,
  TR,
  Table,
} from '../components/ui.tsx';
import { useDebounced } from '../hooks/useDebounced.ts';
import { useT, type Translate } from '../i18n.tsx';

/** Long enough that a half-typed pattern does not cost a request. */
const TEST_DEBOUNCE_MS = 400;

const CONTROL = 'bg-surface border-subtle text-primary w-full rounded border px-2 py-1.5 text-sm';

function TestPanel({
  pattern,
  flags,
  scope,
  tagFilter,
  t,
}: {
  pattern: string;
  flags: string;
  scope: RuleScope;
  tagFilter: number[];
  t: Translate;
}): ReactNode {
  const debounced = useDebounced(pattern, TEST_DEBOUNCE_MS);
  const input = useMemo(
    () => ({ pattern: debounced, flags, scope, tagFilter }),
    [debounced, flags, scope, tagFilter],
  );

  const test = useRuleTest(input, debounced.trim() !== '');

  return (
    <section className="border-subtle bg-base mt-4 rounded-lg border p-3">
      <h3 className="text-primary text-sm font-medium">{t('rules.test.title')}</h3>
      <p className="text-muted mt-0.5 text-xs">{t('rules.test.hint')}</p>

      {debounced.trim() === '' && (
        <p className="text-secondary mt-2 text-sm">{t('rules.test.needsPattern')}</p>
      )}
      {test.isFetching && <p className="text-secondary mt-2 text-sm">{t('rules.test.pending')}</p>}

      {test.data !== undefined &&
        !test.isFetching &&
        (test.data.valid ? (
          <>
            <p
              role="status"
              className={`mt-2 text-sm ${test.data.matchCount === 0 ? 'text-secondary' : 'text-positive'}`}
            >
              {test.data.matchCount === 0
                ? t('rules.test.none')
                : t('rules.test.result', {
                    matchCount: test.data.matchCount,
                    sampleSize: test.data.sampleSize,
                  })}
            </p>
            <ul className="divide-subtle mt-2 divide-y">
              {test.data.matches.map((match) => (
                <li key={match.itemId} className="py-1.5">
                  <span className="text-primary block text-sm leading-snug">
                    <Highlighted title={match.title} highlight={match.highlight} />
                  </span>
                  <span className="text-muted text-xs">
                    {match.sourceTitle} ·{' '}
                    {t('rules.test.matchIn', { field: match.highlight.field })}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          // An invalid or unsafe pattern is data here, not an error: the user is
          // mid-edit and the panel has to keep working.
          <p role="alert" className="text-negative mt-2 text-sm">
            {t('rules.test.invalid', { error: test.data.error })}
          </p>
        ))}
    </section>
  );
}

/** Marks the matched span, when the match was in the title. */
function Highlighted({
  title,
  highlight,
}: {
  title: string;
  highlight: { field: string; start: number; end: number };
}): ReactNode {
  if (highlight.field !== 'title') return <span>{title}</span>;

  return (
    <span>
      {title.slice(0, highlight.start)}
      <mark>{title.slice(highlight.start, highlight.end)}</mark>
      {title.slice(highlight.end)}
    </span>
  );
}

function AddRuleForm({ t }: { t: Translate }): ReactNode {
  const tags = useTags();
  const create = useCreateRule();

  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('i');
  const [scope, setScope] = useState<RuleScope>('both');
  const [weight, setWeight] = useState('1');
  const [alert, setAlert] = useState(false);
  const [tagFilter, setTagFilter] = useState<number[]>([]);

  return (
    <Panel title={t('rules.add')} description={t('rules.intro')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const parsedWeight = Number(weight);
          if (!Number.isFinite(parsedWeight)) return;

          create.mutate(
            { name: name.trim(), pattern, flags, scope, weight: parsedWeight, alert, tagFilter },
            {
              onSuccess: () => {
                setName('');
                setPattern('');
                setWeight('1');
                setAlert(false);
                setTagFilter([]);
              },
            },
          );
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="rule-name" className="text-secondary mb-1 block text-sm">
              {t('rules.field.name')}
            </label>
            <input
              id="rule-name"
              value={name}
              placeholder={t('rules.field.name.placeholder')}
              onChange={(event) => setName(event.target.value)}
              required
              className={CONTROL}
            />
          </div>

          <div>
            <label htmlFor="rule-pattern" className="text-secondary mb-1 block text-sm">
              {t('rules.field.pattern')}
            </label>
            <input
              id="rule-pattern"
              value={pattern}
              placeholder={t('rules.field.pattern.placeholder')}
              onChange={(event) => setPattern(event.target.value)}
              required
              className={`${CONTROL} font-mono`}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="rule-flags" className="text-secondary mb-1 block text-sm">
              {t('rules.field.flags')}
            </label>
            <input
              id="rule-flags"
              value={flags}
              maxLength={4}
              onChange={(event) => setFlags(event.target.value)}
              className={`${CONTROL} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="rule-scope" className="text-secondary mb-1 block text-sm">
              {t('rules.field.scope')}
            </label>
            <select
              id="rule-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as RuleScope)}
              className={CONTROL}
            >
              {RULE_SCOPES.map((option) => (
                <option key={option} value={option}>
                  {t(`rules.scope.${option}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="rule-weight" className="text-secondary mb-1 block text-sm">
              {t('rules.field.weight')}
            </label>
            <input
              id="rule-weight"
              type="number"
              step="0.5"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              aria-describedby="rule-weight-hint"
              className={CONTROL}
            />
            <p id="rule-weight-hint" className="text-muted mt-1 text-xs">
              {t('rules.field.weight.hint')}
            </p>
          </div>
        </div>

        <CheckboxField
          label={t('rules.field.alert')}
          checked={alert}
          onChange={(event) => setAlert(event.target.checked)}
        />

        {(tags.data ?? []).length > 0 && (
          <fieldset>
            <legend className="text-secondary text-sm">{t('rules.field.tagFilter')}</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {(tags.data ?? []).map((tag) => (
                <CheckboxField
                  key={tag.id}
                  label={tag.name}
                  checked={tagFilter.includes(tag.id)}
                  onChange={(event) =>
                    setTagFilter((current) =>
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

        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || pattern.trim() === ''}
        >
          {create.isPending ? t('rules.adding') : t('rules.add')}
        </Button>
      </form>

      {create.error !== null && (
        <div className="mt-3">
          <Notice tone="error">{t('error.generic', { message: create.error.message })}</Notice>
        </div>
      )}
      {create.isSuccess && (
        <div className="mt-3 space-y-1">
          <Notice tone="success">{t('rules.added')}</Notice>
          <p className="text-muted text-xs">{t('rules.rescoreQueued')}</p>
        </div>
      )}

      <TestPanel pattern={pattern} flags={flags} scope={scope} tagFilter={tagFilter} t={t} />
    </Panel>
  );
}

function RuleRow({ rule, t }: { rule: Rule; t: Translate }): ReactNode {
  const update = useUpdateRule();
  const remove = useDeleteRule();

  return (
    <TR>
      <TD className="max-w-xs">
        <span className="text-primary text-sm font-medium">{rule.name}</span>
        {rule.lastError !== null && (
          // A rule that stopped applying has to say why.
          <span role="alert" className="text-negative mt-0.5 block text-xs">
            {t('rules.disabledByBudget', { reason: rule.lastError })}
          </span>
        )}
      </TD>

      <TD>
        <Mono>{rule.pattern}</Mono>
        {rule.flags !== '' && <span className="text-muted ml-1 text-xs">{`/${rule.flags}`}</span>}
      </TD>

      <TD>
        <span className="text-secondary text-xs">{t(`rules.scope.${rule.scope}`)}</span>
      </TD>

      <TD align="right">
        {/* A negative weight demotes; the sign is the whole meaning, so it shows. */}
        <span className={rule.weight < 0 ? 'text-negative' : 'text-primary'}>
          {rule.weight > 0 ? `+${rule.weight}` : rule.weight}
        </span>
      </TD>

      <TD>{rule.alert ? <span className="text-accent text-sm">✓</span> : null}</TD>

      <TD>
        <span className={rule.active ? 'text-positive text-xs' : 'text-muted text-xs'}>
          {rule.active ? t('rules.state.active') : t('rules.state.inactive')}
        </span>
      </TD>

      <TD align="right">
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: rule.id, active: !rule.active })}
          >
            {rule.active ? t('rules.disable') : t('rules.enable')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (!window.confirm(t('rules.delete.confirm', { name: rule.name }))) return;
              remove.mutate(rule.id);
            }}
          >
            {t('common.delete')}
          </Button>
        </div>
      </TD>
    </TR>
  );
}

export function Rules(): ReactNode {
  const t = useT();
  const rules = useRules();

  return (
    <section>
      <PageHeader title={t('rules.title')} description={t('rules.intro')} />

      <div className="space-y-5">
        <AddRuleForm t={t} />

        {rules.isPending && <p className="text-secondary text-sm">{t('common.loading')}</p>}

        {rules.error !== null && (
          <Notice tone="error">
            {t('rules.error')}{' '}
            <button type="button" onClick={() => void rules.refetch()} className="underline">
              {t('common.retry')}
            </button>
          </Notice>
        )}

        {rules.data !== undefined && rules.data.length === 0 && (
          <EmptyState message={t('rules.empty')} />
        )}

        {rules.data !== undefined && rules.data.length > 0 && (
          <Table
            head={
              <>
                <TH>{t('rules.column.name')}</TH>
                <TH>{t('rules.column.pattern')}</TH>
                <TH>{t('rules.column.scope')}</TH>
                <TH align="right">{t('rules.column.weight')}</TH>
                <TH>{t('rules.column.alert')}</TH>
                <TH>{t('rules.column.state')}</TH>
                <TH align="right">{t('sources.column.actions')}</TH>
              </>
            }
          >
            {rules.data.map((rule) => (
              <RuleRow key={rule.id} rule={rule} t={t} />
            ))}
          </Table>
        )}
      </div>
    </section>
  );
}
