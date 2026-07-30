/**
 * The scoring engine (02-SPEC-ingestion.md 5).
 *
 *   score = (base + ruleWeights + engagement) x source.weight x recencyDecay
 *
 * A pure function with no I/O. Every score has to be explainable in the UI, which
 * is why it returns the breakdown alongside the number rather than only the number
 * (decision D5).
 */

import type { ScoreBreakdown, SourceKind } from '@feedhub/shared';

export const BASE_SCORE = 1.0;

/** Logarithmic, so a 5000-upvote post does not permanently outrank everything. */
export const ENGAGEMENT_CAP = 2.0;
export const ENGAGEMENT_FACTOR = 0.5;

export const RECENCY_HALF_LIFE_HOURS = 24;
/** Floored, so an old but heavily-boosted item does not decay to nothing. */
export const RECENCY_FLOOR = 0.15;

/** `numeric(6,2)`: two decimals, and the column cannot hold more than 9999.99. */
const SCORE_SCALE = 100;
const SCORE_MAX = 9999.99;
const SCORE_MIN = -9999.99;

export interface MatchedRule {
  id: number;
  name: string;
  weight: number;
}

export interface ScoringInput {
  /** Rules that matched, already filtered by scope and tag filter. */
  matchedRules: readonly MatchedRule[];
  /** Reddit upvotes. Null for every other kind. */
  engagementScore: number | null;
  sourceKind: SourceKind;
  sourceWeight: number;
  publishedAt: Date;
  /** Injected so scoring is deterministic in tests and consistent across a batch. */
  now: Date;
}

export interface ScoringResult {
  score: number;
  breakdown: ScoreBreakdown;
}

/** `min(2.0, log10(max(1, ups)) x 0.5)`, Reddit only. */
export function engagementComponent(kind: SourceKind, engagementScore: number | null): number {
  if (kind !== 'reddit') return 0;
  if (engagementScore === null) return 0;

  const ups = Math.max(1, engagementScore);
  return Math.min(ENGAGEMENT_CAP, Math.log10(ups) * ENGAGEMENT_FACTOR);
}

/** `max(0.15, 0.5 ^ (ageHours / 24))`. */
export function recencyDecay(publishedAt: Date, now: Date): number {
  const ageMs = now.getTime() - publishedAt.getTime();
  // A feed with a clock skew can produce a future date; treat it as brand new
  // rather than letting a negative age inflate the multiplier above 1.
  const ageHours = Math.max(0, ageMs / 3_600_000);

  return Math.max(RECENCY_FLOOR, Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS));
}

function round(value: number): number {
  return Math.round(value * SCORE_SCALE) / SCORE_SCALE;
}

export function computeScore(input: ScoringInput): ScoringResult {
  const ruleWeights = input.matchedRules.reduce((total, rule) => total + rule.weight, 0);
  const engagement = engagementComponent(input.sourceKind, input.engagementScore);
  const decay = recencyDecay(input.publishedAt, input.now);

  const raw = (BASE_SCORE + ruleWeights + engagement) * input.sourceWeight * decay;

  // Clamp to what the column can hold. A rule weight is capped at 99.99 and a
  // source weight at 10, so this only bites if someone stacks many heavy rules.
  const score = round(Math.min(SCORE_MAX, Math.max(SCORE_MIN, raw)));

  return {
    score,
    breakdown: {
      base: BASE_SCORE,
      rules: input.matchedRules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        weight: rule.weight,
      })),
      engagement: round(engagement),
      sourceWeight: input.sourceWeight,
      recencyDecay: round(decay),
    },
  };
}

/**
 * Recompute a score from a stored breakdown's inputs, without re-running any
 * regexes.
 *
 * `score:refresh` exists because the decay term drifts with time, not because
 * matches change. Reusing `items.matched_rules` turns an hourly job that would
 * otherwise re-evaluate every pattern into arithmetic.
 */
export function rescoreFromStoredMatches(input: ScoringInput): ScoringResult {
  return computeScore(input);
}
