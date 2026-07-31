/**
 * The score-breakdown popover (04-SPEC-frontend.md 4.1).
 *
 * Clicking the score badge opens this. It is how a rule set gets debugged: every
 * term of the formula, and the rules that fired, by name.
 */

import type { ReactNode } from 'react';
import { useItemDetail } from '../api/queries.ts';
import { useT } from '../i18n.tsx';
import { Button } from './ui.tsx';

function round(value: number): string {
  return value.toFixed(2);
}

/** One term of the formula. */
function Term({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="col-span-2 grid grid-cols-subgrid items-baseline py-1">
      <dt className="text-secondary text-xs">{label}</dt>
      <dd className="text-primary text-right text-sm tabular-nums">{value}</dd>
    </div>
  );
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

  if (detail.isPending) {
    return <p className="text-secondary text-sm">{t('breakdown.loading')}</p>;
  }

  if (detail.error !== null) {
    return (
      <p role="alert" className="text-negative flex items-center gap-2 text-sm">
        {t('error.generic', { message: detail.error.message })}
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('breakdown.close')}
        </Button>
      </p>
    );
  }

  const { breakdown, liveScore } = detail.data;
  const ruleTotal = breakdown.rules.reduce((total, rule) => total + rule.weight, 0);

  return (
    <aside
      role="dialog"
      aria-label={t('breakdown.title')}
      className="bg-surface border-subtle mt-2 rounded-lg border p-3 shadow-sm"
    >
      <div className="mb-2 flex items-center">
        <h4 className="text-primary mr-auto text-sm font-medium">{t('breakdown.title')}</h4>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('breakdown.close')}
        </Button>
      </div>

      <dl className="divide-subtle grid grid-cols-[1fr_auto] divide-y">
        <Term label={t('breakdown.base')} value={round(breakdown.base)} />

        <div className="col-span-2 grid grid-cols-subgrid items-baseline py-1">
          <dt className="text-secondary text-xs">{t('breakdown.rules')}</dt>
          <dd className="text-primary text-right text-sm tabular-nums">
            {breakdown.rules.length === 0 ? (
              <span className="text-muted text-xs">{t('breakdown.noRules')}</span>
            ) : (
              <ul>
                {breakdown.rules.map((rule) => (
                  <li key={rule.id} className="whitespace-nowrap">
                    <span className="text-secondary text-xs">{rule.name}</span>{' '}
                    <span className={rule.weight < 0 ? 'text-negative' : 'text-positive'}>
                      {rule.weight > 0 ? `+${round(rule.weight)}` : round(rule.weight)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>

        <Term label={t('breakdown.engagement')} value={round(breakdown.engagement)} />
        <Term label={t('breakdown.sourceWeight')} value={`×${round(breakdown.sourceWeight)}`} />
        <Term label={t('breakdown.recencyDecay')} value={`×${round(breakdown.recencyDecay)}`} />
      </dl>

      <p className="border-subtle text-secondary mt-2 border-t pt-2 font-mono text-xs">
        {t('breakdown.formula', {
          base: round(breakdown.base),
          rules: round(ruleTotal),
          engagement: round(breakdown.engagement),
          sourceWeight: round(breakdown.sourceWeight),
          recencyDecay: round(breakdown.recencyDecay),
          total: round(liveScore),
        })}
      </p>

      <p className="text-muted mt-2 text-xs">
        {t('breakdown.stored', { stored: round(storedScore), live: round(liveScore) })}
      </p>
      {/* Explaining the gap rather than hiding it: the stored score was computed
          at scoring time and the recency term has kept falling since. */}
      {Math.abs(storedScore - liveScore) >= 0.01 && (
        <p className="text-muted mt-1 text-xs">{t('breakdown.drift')}</p>
      )}
    </aside>
  );
}
