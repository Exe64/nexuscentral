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
import { useDebounced } from '../hooks/useDebounced.ts';
import { useT, type Translate } from '../i18n.tsx';

/** Long enough that a half-typed pattern does not cost a request. */
const TEST_DEBOUNCE_MS = 400;

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
    <section>
      <h4>{t('rules.test.title')}</h4>
      <p>{t('rules.test.hint')}</p>

      {debounced.trim() === '' && <p>{t('rules.test.needsPattern')}</p>}
      {test.isFetching && <p>{t('rules.test.pending')}</p>}

      {test.data !== undefined &&
        !test.isFetching &&
        (test.data.valid ? (
          <>
            <p role="status">
              {test.data.matchCount === 0
                ? t('rules.test.none')
                : t('rules.test.result', {
                    matchCount: test.data.matchCount,
                    sampleSize: test.data.sampleSize,
                  })}
            </p>
            <ul>
              {test.data.matches.map((match) => (
                <li key={match.itemId}>
                  <Highlighted title={match.title} highlight={match.highlight} />{' '}
                  <small>
                    {match.sourceTitle} ·{' '}
                    {t('rules.test.matchIn', { field: match.highlight.field })}
                  </small>
                </li>
              ))}
            </ul>
          </>
        ) : (
          // An invalid or unsafe pattern is data here, not an error: the user is
          // mid-edit and the panel has to keep working.
          <p role="alert">{t('rules.test.invalid', { error: test.data.error })}</p>
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
    <section>
      <h3>{t('rules.add')}</h3>
      <p>{t('rules.intro')}</p>

      <form
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
        <label htmlFor="rule-name">{t('rules.field.name')}</label>
        <input
          id="rule-name"
          value={name}
          placeholder={t('rules.field.name.placeholder')}
          onChange={(event) => setName(event.target.value)}
          required
        />

        <label htmlFor="rule-pattern">{t('rules.field.pattern')}</label>
        <input
          id="rule-pattern"
          value={pattern}
          placeholder={t('rules.field.pattern.placeholder')}
          onChange={(event) => setPattern(event.target.value)}
          required
        />

        <label htmlFor="rule-flags">{t('rules.field.flags')}</label>
        <input
          id="rule-flags"
          value={flags}
          maxLength={4}
          onChange={(event) => setFlags(event.target.value)}
        />

        <label htmlFor="rule-scope">{t('rules.field.scope')}</label>
        <select
          id="rule-scope"
          value={scope}
          onChange={(event) => setScope(event.target.value as RuleScope)}
        >
          {RULE_SCOPES.map((option) => (
            <option key={option} value={option}>
              {t(`rules.scope.${option}`)}
            </option>
          ))}
        </select>

        <label htmlFor="rule-weight">{t('rules.field.weight')}</label>
        <input
          id="rule-weight"
          type="number"
          step="0.5"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
        />
        <small>{t('rules.field.weight.hint')}</small>

        <label>
          <input
            type="checkbox"
            checked={alert}
            onChange={(event) => setAlert(event.target.checked)}
          />
          {t('rules.field.alert')}
        </label>

        {(tags.data ?? []).length > 0 && (
          <fieldset>
            <legend>{t('rules.field.tagFilter')}</legend>
            {(tags.data ?? []).map((tag) => (
              <label key={tag.id}>
                <input
                  type="checkbox"
                  checked={tagFilter.includes(tag.id)}
                  onChange={(event) =>
                    setTagFilter((current) =>
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

        <button type="submit" disabled={create.isPending || pattern.trim() === ''}>
          {create.isPending ? t('rules.adding') : t('rules.add')}
        </button>
      </form>

      {create.error !== null && (
        <p role="alert">{t('error.generic', { message: create.error.message })}</p>
      )}
      {create.isSuccess && (
        <>
          <p role="status">{t('rules.added')}</p>
          <p>{t('rules.rescoreQueued')}</p>
        </>
      )}

      <TestPanel pattern={pattern} flags={flags} scope={scope} tagFilter={tagFilter} t={t} />
    </section>
  );
}

function RuleRow({ rule, t }: { rule: Rule; t: Translate }): ReactNode {
  const update = useUpdateRule();
  const remove = useDeleteRule();

  return (
    <tr>
      <td>
        {rule.name}
        {rule.lastError !== null && (
          <>
            <br />
            {/* A rule that stopped applying has to say why. */}
            <small role="alert">{t('rules.disabledByBudget', { reason: rule.lastError })}</small>
          </>
        )}
      </td>
      <td>
        <code>{rule.pattern}</code>
        {rule.flags !== '' && <small>{` /${rule.flags}`}</small>}
      </td>
      <td>{t(`rules.scope.${rule.scope}`)}</td>
      <td>{rule.weight}</td>
      <td>{rule.alert ? '✓' : ''}</td>
      <td>{rule.active ? t('rules.state.active') : t('rules.state.inactive')}</td>
      <td>
        <button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: rule.id, active: !rule.active })}
        >
          {rule.active ? t('rules.disable') : t('rules.enable')}
        </button>{' '}
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (!window.confirm(t('rules.delete.confirm', { name: rule.name }))) return;
            remove.mutate(rule.id);
          }}
        >
          {t('common.delete')}
        </button>
      </td>
    </tr>
  );
}

export function Rules(): ReactNode {
  const t = useT();
  const rules = useRules();

  return (
    <section>
      <h2>{t('rules.title')}</h2>

      <AddRuleForm t={t} />

      {rules.isPending && <p>{t('common.loading')}</p>}

      {rules.error !== null && (
        <p role="alert">
          {t('rules.error')}{' '}
          <button type="button" onClick={() => void rules.refetch()}>
            {t('common.retry')}
          </button>
        </p>
      )}

      {rules.data !== undefined && rules.data.length === 0 && <p>{t('rules.empty')}</p>}

      {rules.data !== undefined && rules.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('rules.column.name')}</th>
              <th>{t('rules.column.pattern')}</th>
              <th>{t('rules.column.scope')}</th>
              <th>{t('rules.column.weight')}</th>
              <th>{t('rules.column.alert')}</th>
              <th>{t('rules.column.state')}</th>
              <th>{t('sources.column.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.data.map((rule) => (
              <RuleRow key={rule.id} rule={rule} t={t} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
