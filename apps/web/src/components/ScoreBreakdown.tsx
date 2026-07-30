/**
 * The score-breakdown popover (04-SPEC-frontend.md 4.1).
 *
 * Clicking the score badge opens this. It is how a rule set gets debugged: every
 * term of the formula, and the rules that fired, by name.
 */

import type { ReactNode } from 'react';
import { useItemDetail } from '../api/queries.ts';
import { useT } from '../i18n.tsx';

function round(value: number): string {
  return value.toFixed(2);
}

export function ScoreBreakdown({
  itemId,
  storedScore,
  onClose,
}: {
  itemId: string;
  storedScore: number;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const detail = useItemDetail(itemId);

  if (detail.isPending) return <p>{t('breakdown.loading')}</p>;

  if (detail.error !== null) {
    return (
      <p role="alert">
        {t('error.generic', { message: detail.error.message })}{' '}
        <button type="button" onClick={onClose}>
          {t('breakdown.close')}
        </button>
      </p>
    );
  }

  const { breakdown, liveScore } = detail.data;
  const ruleTotal = breakdown.rules.reduce((total, rule) => total + rule.weight, 0);

  return (
    <aside role="dialog" aria-label={t('breakdown.title')}>
      <h4>{t('breakdown.title')}</h4>

      <dl>
        <dt>{t('breakdown.base')}</dt>
        <dd>{round(breakdown.base)}</dd>

        <dt>{t('breakdown.rules')}</dt>
        <dd>
          {breakdown.rules.length === 0 ? (
            t('breakdown.noRules')
          ) : (
            <ul>
              {breakdown.rules.map((rule) => (
                <li key={rule.id}>
                  {rule.name}: {rule.weight > 0 ? `+${round(rule.weight)}` : round(rule.weight)}
                </li>
              ))}
            </ul>
          )}
        </dd>

        <dt>{t('breakdown.engagement')}</dt>
        <dd>{round(breakdown.engagement)}</dd>

        <dt>{t('breakdown.sourceWeight')}</dt>
        <dd>×{round(breakdown.sourceWeight)}</dd>

        <dt>{t('breakdown.recencyDecay')}</dt>
        <dd>×{round(breakdown.recencyDecay)}</dd>
      </dl>

      <p>
        {t('breakdown.formula', {
          base: round(breakdown.base),
          rules: round(ruleTotal),
          engagement: round(breakdown.engagement),
          sourceWeight: round(breakdown.sourceWeight),
          recencyDecay: round(breakdown.recencyDecay),
          total: round(liveScore),
        })}
      </p>

      <p>{t('breakdown.stored', { stored: round(storedScore), live: round(liveScore) })}</p>
      {/* Explaining the gap rather than hiding it: the stored score was computed
          at scoring time and the recency term has kept falling since. */}
      {Math.abs(storedScore - liveScore) >= 0.01 && <p>{t('breakdown.drift')}</p>}

      <button type="button" onClick={onClose}>
        {t('breakdown.close')}
      </button>
    </aside>
  );
}
