import { describe, expect, it } from 'vitest';
import {
  BASE_SCORE,
  computeScore,
  engagementComponent,
  RECENCY_FLOOR,
  recencyDecay,
  type MatchedRule,
} from '../../src/scoring/engine.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

function input(overrides: Partial<Parameters<typeof computeScore>[0]> = {}) {
  return {
    matchedRules: [] as MatchedRule[],
    engagementScore: null,
    sourceKind: 'rss' as const,
    sourceWeight: 1,
    publishedAt: NOW,
    now: NOW,
    ...overrides,
  };
}

describe('engagementComponent', () => {
  it('is zero for every kind but reddit', () => {
    // Only Reddit supplies an upvote count; the column is null elsewhere.
    expect(engagementComponent('rss', 500)).toBe(0);
    expect(engagementComponent('nitter', 500)).toBe(0);
    expect(engagementComponent('reddit', 500)).toBeGreaterThan(0);
  });

  it('is zero when there is no engagement figure', () => {
    expect(engagementComponent('reddit', null)).toBe(0);
  });

  it('treats zero and one upvote as the same floor', () => {
    // log10(0) is -Infinity; the max(1, ups) guard is what stops that.
    expect(engagementComponent('reddit', 0)).toBe(0);
    expect(engagementComponent('reddit', 1)).toBe(0);
  });

  it('grows logarithmically, so a viral post cannot dominate forever', () => {
    const ten = engagementComponent('reddit', 10);
    const hundred = engagementComponent('reddit', 100);
    const thousand = engagementComponent('reddit', 1000);

    expect(ten).toBeCloseTo(0.5, 5);
    expect(hundred).toBeCloseTo(1.0, 5);
    expect(thousand).toBeCloseTo(1.5, 5);
    // Each tenfold increase adds the same amount, not ten times as much.
    expect(hundred - ten).toBeCloseTo(thousand - hundred, 5);
  });

  it('caps at 2.0', () => {
    expect(engagementComponent('reddit', 10_000)).toBeCloseTo(2.0, 5);
    expect(engagementComponent('reddit', 5_000_000)).toBe(2.0);
  });

  it('handles a negative score without producing NaN', () => {
    // Reddit can report a negative score on a heavily downvoted post.
    expect(engagementComponent('reddit', -50)).toBe(0);
  });
});

describe('recencyDecay', () => {
  it('is 1 for something published right now', () => {
    expect(recencyDecay(NOW, NOW)).toBe(1);
  });

  it('halves every 24 hours, until the floor', () => {
    expect(recencyDecay(hoursAgo(24), NOW)).toBeCloseTo(0.5, 6);
    expect(recencyDecay(hoursAgo(48), NOW)).toBeCloseTo(0.25, 6);
    // The third halving would give 0.125, which is below the floor.
    expect(recencyDecay(hoursAgo(72), NOW)).toBe(RECENCY_FLOOR);
  });

  it('reaches the floor at about 66 hours', () => {
    // 0.5 ^ (t/24) = 0.15 at t = 24 x log2(1/0.15) ~= 65.7 hours. Worth pinning:
    // it is the age past which recency stops discriminating at all, which is why
    // score:refresh only bothers with the last 7 days.
    expect(recencyDecay(hoursAgo(65), NOW)).toBeGreaterThan(RECENCY_FLOOR);
    expect(recencyDecay(hoursAgo(66), NOW)).toBe(RECENCY_FLOOR);
  });

  it('is floored, so an old but boosted item does not vanish', () => {
    expect(recencyDecay(hoursAgo(24 * 30), NOW)).toBe(RECENCY_FLOOR);
    expect(recencyDecay(hoursAgo(24 * 365), NOW)).toBe(RECENCY_FLOOR);
  });

  it('treats a future date as brand new rather than inflating the multiplier', () => {
    // A feed with clock skew can publish in the future; the multiplier must not
    // exceed 1 and hand that item a permanent advantage.
    const future = new Date(NOW.getTime() + 6 * 3_600_000);
    expect(recencyDecay(future, NOW)).toBe(1);
  });
});

describe('computeScore', () => {
  it('scores a plain new item at the base', () => {
    const { score } = computeScore(input());
    expect(score).toBe(BASE_SCORE);
  });

  it('follows the spec formula exactly', () => {
    // (base + ruleWeights + engagement) x sourceWeight x recencyDecay
    // (1 + 5 + 1.0) x 1.5 x 0.5 = 5.25
    const { score } = computeScore(
      input({
        matchedRules: [{ id: 3, name: 'CVE mentions', weight: 5 }],
        engagementScore: 100,
        sourceKind: 'reddit',
        sourceWeight: 1.5,
        publishedAt: hoursAgo(24),
      }),
    );
    expect(score).toBe(5.25);
  });

  it('sums several matching rules', () => {
    const { score } = computeScore(
      input({
        matchedRules: [
          { id: 1, name: 'a', weight: 2 },
          { id: 2, name: 'b', weight: 3 },
        ],
      }),
    );
    expect(score).toBe(6);
  });

  it('lets a negative weight demote an item, which is how noise is buried', () => {
    const { score } = computeScore(
      input({ matchedRules: [{ id: 1, name: 'press releases', weight: -4 }] }),
    );
    expect(score).toBe(-3);
  });

  it('can drive a score below zero, which is the point of demotion', () => {
    const { score } = computeScore(
      input({
        matchedRules: [{ id: 1, name: 'noise', weight: -10 }],
        publishedAt: hoursAgo(48),
      }),
    );
    expect(score).toBeLessThan(0);
  });

  it('scales by the source weight', () => {
    const neutral = computeScore(input({ sourceWeight: 1 })).score;
    const trusted = computeScore(input({ sourceWeight: 2 })).score;
    expect(trusted).toBe(neutral * 2);
  });

  it('collapses to zero for a source weighted zero', () => {
    // Weight 0 is a legitimate way to keep a source's items without ranking them.
    expect(
      computeScore(input({ sourceWeight: 0, matchedRules: [{ id: 1, name: 'x', weight: 9 }] }))
        .score,
    ).toBe(0);
  });

  it('rounds to the two decimals the column stores', () => {
    const { score } = computeScore(
      input({ engagementScore: 37, sourceKind: 'reddit', publishedAt: hoursAgo(7) }),
    );
    expect(score).toBe(Math.round(score * 100) / 100);
    expect(String(score).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('clamps to what numeric(6,2) can hold', () => {
    const { score } = computeScore(
      input({
        matchedRules: Array.from({ length: 200 }, (_unused, index) => ({
          id: index,
          name: `r${index}`,
          weight: 99.99,
        })),
        sourceWeight: 10,
      }),
    );
    expect(score).toBeLessThanOrEqual(9999.99);
  });
});

describe('the breakdown', () => {
  it('explains every term of the score', () => {
    // "Why is this item scored 8.4?" has to be answerable in the UI (decision D5).
    const { score, breakdown } = computeScore(
      input({
        matchedRules: [{ id: 3, name: 'CVE mentions', weight: 5 }],
        engagementScore: 500,
        sourceKind: 'reddit',
        sourceWeight: 1.5,
        publishedAt: hoursAgo(8),
      }),
    );

    expect(breakdown.base).toBe(1);
    expect(breakdown.rules).toEqual([{ id: 3, name: 'CVE mentions', weight: 5 }]);
    expect(breakdown.engagement).toBeCloseTo(1.35, 2);
    expect(breakdown.sourceWeight).toBe(1.5);
    expect(breakdown.recencyDecay).toBeCloseTo(0.79, 2);

    // The terms have to reproduce the number, or the explanation is a decoration.
    const reconstructed =
      (breakdown.base +
        breakdown.rules.reduce((total, rule) => total + rule.weight, 0) +
        breakdown.engagement) *
      breakdown.sourceWeight *
      breakdown.recencyDecay;
    expect(reconstructed).toBeCloseTo(score, 1);
  });

  it('names the rules that fired so a rule set can be debugged', () => {
    const { breakdown } = computeScore(
      input({
        matchedRules: [
          { id: 1, name: 'CVE mentions', weight: 5 },
          { id: 2, name: 'Press releases', weight: -2 },
        ],
      }),
    );

    expect(breakdown.rules.map((rule) => rule.name)).toEqual(['CVE mentions', 'Press releases']);
  });

  it('reports an empty rule list rather than omitting the field', () => {
    expect(computeScore(input()).breakdown.rules).toEqual([]);
  });
});
